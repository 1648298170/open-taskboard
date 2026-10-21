import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computePosition, flip, shift } from '@floating-ui/dom';
import { activeClaim, api_, Commit, Issue, IssueDetail, PRIORITIES, STATUS_CN, Status } from '../api';
import { Markdown } from '../markdown';
import { confirmDialog, promptDialog } from './dialogs';
import { fmtHMLocal, fmtWhenLocal } from '../logic/time';
import { applyMention, mentionCandidatesFor, MentionCandidate, nextHi } from '../logic/mention';
import { Pencil, Plus, Sparkles, UserRound, X } from 'lucide-react';
import { WAKE_PREFIX } from '@taskboard/core/types';

const fmtWhen = fmtWhenLocal;
import { Select } from './Select';



/** T7-39: 字节数人性化（B / KB / MB）。 */
const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;

// 评论提及候选：前缀取自 core 的 WAKE_PREFIX（与 Store 重开规则、watch 投递
// 规则同源；taskboard watch --on 可改运行时前缀，此处只反映默认值）。
const MENTION_CANDIDATES: MentionCandidate[] = [{ value: WAKE_PREFIX, label: '唤醒 agent 干活（主进程忙时排队：收尾当前任务后接手 · Enter 选择）' }];

export function Drawer({ issueId, projectId, refreshKey, statuses, onClose, onChanged, onToast, onOpenIssue, issues }: {
  issueId: string;
  /** Incremented by the app-level SSE handler to refresh live execution history. */
  refreshKey: number;
  /** 当前项目 id —— 抽屉打开时拉一次 git 分支/工作树列表（T2-8） */
  projectId: string | null;
  statuses: readonly Status[];
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
  onOpenIssue: (id: string) => void;
  /** 项目全量任务（未过滤），用于依赖行的状态/标题解析 */
  issues: Issue[];
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [desc, setDesc] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [comment, setComment] = useState('');
  // v0.4: 评论删除两步内联确认——✕ 点击后变「确认删除」，3s 不点自动还原（无弹窗）。
  const [confirmingComment, setConfirmingComment] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  // v0.4: 依赖边移除同款两步内联确认（全局删除必须有二次确认）。
  const [confirmingDep, setConfirmingDep] = useState<string | null>(null);
  // v0.4: mention 候选浮层 —— floating-ui 定位（top-start，翻转+防溢出）。
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!comment.trim().startsWith('@') || !commentInputRef.current || !mentionRef.current) return;
    void computePosition(commentInputRef.current, mentionRef.current, {
      placement: 'top-start', strategy: 'fixed', middleware: [flip(), shift()]
    }).then(({ x, y }) => {
      if (mentionRef.current) {
        mentionRef.current.style.left = `${x}px`;
        mentionRef.current.style.top = `${y}px`;
      }
    });
  }, [comment]);
  const [mentionHi, setMentionHi] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  useEffect(() => { setMentionDismissed(false); setMentionHi(0); }, [comment]);
  const mentionFrag = /^@([\w-]*)$/.exec(comment.trim());
  const mentionHits = mentionFrag
    ? mentionCandidatesFor(mentionFrag[1], MENTION_CANDIDATES).filter(c => c.value !== comment.trim())
    : [];
  const mentionOpen = !!mentionFrag && mentionHits.length > 0 && !mentionDismissed;
  const mentionHiSafe = Math.min(mentionHi, Math.max(mentionHits.length - 1, 0));
  const pickMention = (c: MentionCandidate): void => {
    setComment(applyMention(comment, c.value));
    commentInputRef.current?.focus();
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  // T6-36: 最近提交预览。null = 加载中/不可用。
  const [commits, setCommits] = useState<Commit[] | null>(null);

  const load = async (): Promise<void> => {
    try {
      setDetail(await api_.showIssue(issueId));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };
  useEffect(() => { setDetail(null); setDesc(''); setEditingDesc(false); setLoadError(null); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [issueId]);
  useEffect(() => { if (refreshKey > 0) void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshKey]);

  // T6-36: 绑定分支/工作树时预览最近提交（工作树优先——名字会被服务端
  // 解析成该工作树 checkout 的 HEAD）。换任务或换绑定即重取。
  const commitRef = detail ? (detail.worktree || detail.branch || '') : '';
  const executionEvents = detail ? detail.activities.filter(a => a.action === 'execution').slice(0, 5) : [];
  const visibleActivities = detail ? detail.activities.filter(a => a.action !== 'execution') : [];
  useEffect(() => {
    setCommits(null);
    if (!projectId || !commitRef) return;
    let stale = false;
    api_.commits(projectId, commitRef)
      .then(list => { if (!stale) setCommits(list); })
      .catch(() => { if (!stale) setCommits([]); });
    return () => { stale = true; };
  }, [projectId, commitRef]);

  // v0.4: 三个状态（加载中/错误/详情）共用同一 aside 骨架——结构稳定，
  // React 复用元素不重挂，杜绝 drawer-in 动画重播造成的闪烁。
  const head = (
    <div className="drawer-head">
      <span className="issue-id">#{issueId}{detail ? ` · v${detail.version}` : ' · 加载中'}</span>
      <button className="icon-btn" onClick={onClose}><X size={16} /></button>
    </div>
  );
  if (loadError || !detail) {
    return (
      <>
        <div className="drawer-backdrop" onClick={onClose} />
        <aside className="drawer">
          {head}
          {loadError
            ? <p style={{ color: 'var(--danger)', padding: '12px 4px' }}>加载失败：{loadError}</p>
            : <p style={{ color: 'var(--ink-dim)', padding: '12px 4px' }}>加载中…</p>}
        </aside>
      </>
    );
  }

  const patch = async (body: Partial<IssueDetail>): Promise<void> => {
    try {
      await api_.updateIssue(issueId, { version: detail.version, ...body });
      onChanged();
      await load();
    } catch (err) { onToast(`✗ ${(err as Error).message}`); }
  };

  const addDep = async (dependsOnId: string): Promise<void> => {
    try {
      await api_.addDependency(detail.id, dependsOnId);
      onToast(`#${detail.id} 被 #${dependsOnId} 阻塞`);
      onChanged(); await load();
    } catch (err) { onToast(`✗ ${(err as Error).message}`); }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
      <div className="drawer-head">
        <span className="issue-id">#{detail.id} · v{detail.version}</span>
        <button className="icon-btn" onClick={onClose}><X size={16} /></button>
      </div>
      <h2 className="task-detail-title" contentEditable suppressContentEditableWarning
        onBlur={e => { const v = e.currentTarget.textContent?.trim(); if (v && v !== detail.title) void patch({ title: v }); }}>
        {detail.title}
      </h2>
      <div className="detail-primary-fields">
        <div className="detail-status-fields">
          <Select value={detail.status} onChange={v => void patch({ status: v as Status })}
            options={statuses.map(st => ({ value: st, label: STATUS_CN[st] ?? st }))} />
          <Select value={detail.priority} onChange={v => void patch({ priority: v as IssueDetail['priority'] })}
            options={PRIORITIES.map(pr => ({ value: pr, label: pr }))} />
        </div>
        <div className="detail-assignee-value" title="负责人"><UserRound size={14} />{detail.assignee || '未分配'}</div>
      </div>

      <section className="detail-properties-grid" aria-label="任务属性">
        <label className="detail-field">
          <span>标签</span>
          <input title="标签（逗号分隔）" placeholder="以逗号分隔" defaultValue={detail.labels}
            onBlur={e => { const v = e.target.value.trim(); if (v !== detail.labels) void patch({ labels: v }); }} />
        </label>
        <label className="detail-field">
          <span>计划开始</span>
          <input type="date" title="计划开始日期" defaultValue={detail.startDate ?? ''}
            onChange={e => { const v = e.target.value || null; if (v !== detail.startDate) void patch({ startDate: v }); }} />
        </label>
        <label className="detail-field">
          <span>截止日期</span>
          <input type="date" title="截止日期" defaultValue={detail.dueDate ?? ''}
            onChange={e => { const v = e.target.value || null; if (v !== detail.dueDate) void patch({ dueDate: v }); }} />
        </label>
        <div className="detail-property"><span>Session</span>{detail.sessionId ? <code title={detail.sessionId}>{detail.sessionId}</code> : <span className="detail-property-empty">继承的项目默认 Session 未配置</span>}</div>
        <div className="detail-property"><span>Git 分支</span><code title={detail.branch || ''}>{detail.branch || '未分配'}</code></div>
        <div className="detail-property"><span>工作树</span><code title={detail.worktree || ''}>{detail.worktree || '未分配'}</code></div>
        <div className="detail-property detail-property-wide"><span>工作树路径</span><code title={detail.worktreePath || ''}>{detail.worktreePath || '未分配'}</code></div>
      </section>
      <div className="detail-actions">
        <button className="btn tiny detail-danger-action" onClick={async () => {
          if (!await confirmDialog({ title: `删除 #${detail.id} 及其子任务/评论？`, danger: true, confirmText: '删除' })) return;
          try {
            await api_.deleteIssue(detail.id);
            onToast('已删除');
            onClose(); onChanged();
          } catch (err) { onToast(`✗ ${(err as Error).message}`); }
        }}>删除任务</button>
        {detail.archivedAt
          ? <button className="btn tiny" onClick={async () => {
              try {
                await api_.unarchiveIssue(detail.id);
                onToast('已取消归档');
                onChanged(); await load();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>取消归档</button>
          : detail.status === 'done' && (
            <button className="btn tiny" onClick={async () => {
              if (!await confirmDialog({ title: `归档 #${detail.id}？`, lines: ['将从看板移除（可随时取消归档）'], confirmText: '归档' })) return;
              try {
                await api_.archiveIssue(detail.id);
                onToast('已归档');
                onClose(); onChanged();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>归档</button>
          )}
        {detail.status !== 'done' && (
          <button className="btn tiny detail-wake-action"
            title="唤醒 Agent：按所属项目的默认 Session 路由任务"
            onClick={async () => {
              try {
                const created = await api_.addComment(detail.id, 'web', `${WAKE_PREFIX} 认领此任务并编排（拆解子任务、排依赖）`);
                onToast(detail.sessionId
                  ? `已入队——watch 将按项目默认 Session ${detail.sessionId} 投递`
                  : '已入队——请先在项目中配置默认 Session，Agent 将按项目路由处理任务');
                onChanged();
                void (async () => {
                  for (let i = 0; i < 5; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                      const fresh = await api_.showIssue(issueId);
                      setDetail(fresh);
                      const st = fresh.comments.find(c => c.id === created.id)?.status;
                      if (st && st !== 'pending') {
                        await new Promise(r => setTimeout(r, 250));
                        try { setDetail(await api_.showIssue(issueId)); } catch { /* keep latest successful detail */ }
                        onToast(st === 'processed' ? '✓ agent 已处理本条唤醒' : '✓ 已送达，agent 处理中');
                        onChanged();
                        return;
                      }
                    } catch { return; }
                  }
                  onToast('⚠ 5 秒内未确认送达：评论仍为 pending。请检查 watch 日志和 OpenCode 服务地址。');
                })();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}><Sparkles size={14} /> 唤醒</button>
        )}
        {activeClaim(detail) !== null
          ? <button className="btn tiny" onClick={async () => {
              try {
                await api_.releaseIssue(detail.id);
                onToast(`#${detail.id} 已释放租约`);
                onChanged(); await load();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>释放认领</button>
          : <button className="btn tiny" onClick={async () => {
              try {
                const claimed = await api_.claimIssue(detail.id);
                onToast(`#${detail.id} 已认领，租约至 ${claimed.leaseExpiresAt ? fmtHMLocal(claimed.leaseExpiresAt) : ''}`);
                onChanged(); await load();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>认领任务</button>}
      </div>

      {/* T7-34: 认领信息（meta 行下单独一行，含续租）。仅有效租约显示。 */}
      {(() => {
        const holder = activeClaim(detail);
        if (holder === null || detail.leaseExpiresAt === null) return null;
        const minutes = Math.max(0, Math.ceil((Date.parse(detail.leaseExpiresAt) - Date.now()) / 60_000));
        return (
          <div className="claim-info">
            <span className="claim-badge"><UserRound size={12} /> {holder} · 剩余 {minutes}m（至 {fmtHMLocal(detail.leaseExpiresAt)}）</span>
            {holder === 'web' && (
              <button className="btn tiny" onClick={async () => {
                try {
                  const beat = await api_.heartbeatIssue(detail.id);
                  onToast(`#${detail.id} 续租成功，至 ${beat.leaseExpiresAt ? fmtHMLocal(beat.leaseExpiresAt) : ''}`);
                  onChanged(); await load();
                } catch (err) { onToast(`✗ ${(err as Error).message}`); }
              }}>续租</button>
            )}
          </div>
        );
      })()}

      <h3>描述
        {!editingDesc && <button className="btn tiny" onClick={() => setEditingDesc(true)}><Pencil size={12} /> 编辑</button>}
      </h3>
      {editingDesc
        ? <textarea rows={8} autoFocus placeholder="任务描述（Markdown）" value={desc || detail.description} onChange={e => setDesc(e.target.value)}
            onBlur={() => {
              if (desc && desc !== detail.description) void patch({ description: desc });
              setEditingDesc(false);
            }} />
        : detail.description
          ? <Markdown src={detail.description} />
          : <p style={{ color: 'var(--ink-dim)', fontSize: 12 }}>暂无描述</p>}

      <h3>子任务
        <button className="btn tiny" onClick={async () => {
          const title = await promptDialog({ title: '子任务标题' });
          if (!title) return;
          try {
            await api_.createIssue(detail.projectId, { parentId: detail.id, title });
            onChanged(); await load();
          } catch (err) { onToast(`✗ ${(err as Error).message}`); }
        }}><Plus size={12} /> 拆解子任务</button>
      </h3>
      <ul className="children">
        {detail.children.length
          ? detail.children.map(c => (
            <li key={c.id} onClick={() => onOpenIssue(c.id)}>
              <span className="st">[{STATUS_CN[c.status] ?? c.status}]</span>{c.title}
            </li>))
          : <li style={{ color: 'var(--ink-dim)' }}>暂无子任务</li>}
      </ul>

      <h3>依赖</h3>
      {/* v0.4: 依赖选择器 —— 下拉选择后立即建边；「手动输入 ID…」保留原 prompt 回退。
          候选：本项目未完成任务，排除自身与已存在的边（双向）。 */}
      <div className="dep-picker">
        <Select value="" placeholder="＋ 添加依赖（选择任务…）"
          onChange={v => {
            if (v === '__manual__') {
              void (async () => {
                const depId = await promptDialog({ title: '被哪个任务阻塞？', placeholder: '输入任务 ID，如 ab12cd34' });
                if (!depId) return;
                await addDep(depId);
              })();
              return;
            }
            void addDep(v);
          }}
          options={[
            ...issues
              .filter(i => i.id !== detail.id
                && i.status !== 'done'
                && !(detail.blockedBy ?? []).includes(i.id)
                && !(detail.blocks ?? []).includes(i.id))
              .map(c => ({ value: c.id, label: `#${c.id} ${c.title} [${STATUS_CN[c.status] ?? c.status}]` })),
            { value: '__manual__', label: '手动输入 ID…' }
          ]} />
      </div>
      <ul className="deps">
        {(() => {
          const byId = new Map(issues.map(i => [i.id, i]));
          const row = (id: string, mark: string, markCls: string, onRemove: (() => Promise<void>) | null, key: string) => {
            const dep = byId.get(id);
            return (
              <li key={key} className="clickable" onClick={() => onOpenIssue(id)}>
                <span className={`mark ${markCls}`}>{mark}</span>
                <span className="st">[{dep?.status ?? '?'}]</span>
                <span className="dep-title">{dep ? dep.title : `#${id}`}</span>
                <span className="dep-id">#{id}</span>
                {onRemove && (confirmingDep === id ? (
                  <button className="btn tiny danger" title="再次点击确认移除"
                    onClick={e => { e.stopPropagation(); setConfirmingDep(null); void onRemove(); }}>确认移除</button>
                ) : (
                  <button className="icon-btn dep-remove" title="移除依赖"
                    onClick={e => {
                      e.stopPropagation();
                      setConfirmingDep(id);
                      setTimeout(() => setConfirmingDep(cur => cur === id ? null : cur), 3000);
                    }}><X size={12} /></button>
                ))}
              </li>
            );
          };
          const removeDep = async (dependsOnId: string): Promise<void> => {
            try {
              await api_.removeDependency(detail.id, dependsOnId);
              onToast(`已解除对 #${dependsOnId} 的依赖`);
              onChanged(); await load();
            } catch (err) { onToast(`✗ ${(err as Error).message}`); }
          };
          const blockedBy = detail.blockedBy ?? [];
          const blocks = detail.blocks ?? [];
          if (!blockedBy.length && !blocks.length) {
            return <li style={{ color: 'var(--ink-dim)' }}>暂无依赖</li>;
          }
          return (<>
            {blockedBy.map(id => row(
              id,
              byId.get(id)?.status === 'done' ? '✓' : '○',
              byId.get(id)?.status === 'done' ? 'done-mark' : 'undone-mark',
              () => removeDep(id),
              `by-${id}`
            ))}
            {blocks.map(id => row(id, '→', 'blocks-mark', null, `blk-${id}`))}
          </>);
        })()}
      </ul>

      <section className="detail-section execution-history">
        <span className="execution-history-title">最近 Agent 执行记录</span>
        {executionEvents.length
          ? <ul>
              {executionEvents.map(event => {
                const separator = event.detail.indexOf('] ');
                const outcome = event.detail.startsWith('[') && separator > 1 ? event.detail.slice(1, separator) : '记录';
                const message = event.detail.startsWith('[') && separator > 1 ? event.detail.slice(separator + 2) : event.detail;
                const outcomeLabel = ({ started: '开始', queued: '已提交', running: '会话执行中', idle: '会话空闲', retrying: '重试', succeeded: '成功', failed: '失败', cancel_requested: '已请求取消' } as Record<string, string>)[outcome] ?? outcome;
                return <li key={event.id}><time>{fmtWhen(event.createdAt)}</time><strong className={`execution-outcome execution-outcome-${outcome}`}>{outcomeLabel}</strong><span>{message}</span></li>;
              })}
            </ul>
          : <p className="detail-empty">暂无执行记录。唤醒 Agent 后，这里会记录提交、重试和失败信息。</p>}
      </section>
      <details className="detail-section detail-disclosure review-context">
        <summary>验收与审核</summary>
        <label className="detail-field">
          <span>验收标准（Markdown）</span>
          <textarea rows={4} defaultValue={detail.acceptanceCriteria}
            placeholder="列出可验证的完成条件，例如：功能行为、边界情况、测试要求…"
            onBlur={e => {
              const value = e.currentTarget.value;
              if (value !== detail.acceptanceCriteria) void patch({ acceptanceCriteria: value });
            }} />
        </label>
        <div className="review-status-row">
          <span>审核结论</span>
          <Select value={detail.reviewStatus} onChange={v => {
            if (v !== detail.reviewStatus) void patch({ reviewStatus: v as IssueDetail['reviewStatus'] });
          }} options={[
            { value: 'pending', label: '待审核' },
            { value: 'approved', label: '已通过' },
            { value: 'changes_requested', label: '需要修改' }
          ]} />
        </div>
        <label className="detail-field">
          <span>审核意见 / 验收证据</span>
          <textarea rows={3} defaultValue={detail.reviewNotes}
            placeholder="记录验证结果、未覆盖项或需要修改的内容…"
            onBlur={e => {
              const value = e.currentTarget.value;
              if (value !== detail.reviewNotes) void patch({ reviewNotes: value });
            }} />
        </label>
      </details>

      {/* T6-36: 最近提交预览 —— 绑定了分支或工作树才显示。 */}
      {commitRef && (
        <details className="detail-section detail-disclosure detail-commits">
          <summary>
            <span>最近提交</span>
            <span className="detail-summary-meta">{commits === null ? '读取中' : `${commits.length} 条`}</span>
          </summary>
          <ul className="commits">
            {commits === null
              ? <li>加载中…</li>
              : commits.length === 0
                ? <li>暂无提交</li>
                : commits.map(c => (
                  <li key={`${c.hash} ${c.subject}`}>
                    <span className="hash">{c.hash}</span>
                    <span className="subject">{c.subject}</span>
                    <span className="when">({c.when})</span>
                  </li>
                ))}
          </ul>
        </details>
      )}

      <h3>评论</h3>
      <ul className="comments">
        {detail.comments.length
          ? detail.comments.map(c => (
            <li key={c.id}>
              {/* v0.4: 头行（作者+删除）与正文分层——正文独立整行，长文不再绕排 */}
              <div className="comment-head">
                <span className="who">{c.author || 'anon'}</span>
                {c.status !== 'pending' && (
                  <span className={`comment-status ${c.status}`}>
                    {c.status === 'processing' ? '唤醒中' : '已处理'}
                  </span>
                )}
                {confirmingComment === c.id ? (
                  <button className="btn tiny danger" title="再次点击确认删除"
                    onClick={async e => {
                      e.stopPropagation();
                      setConfirmingComment(null);
                      try {
                        await api_.deleteComment(c.id);
                        onChanged(); await load();
                      } catch (err) { onToast(`✗ ${(err as Error).message}`); }
                    }}>确认删除</button>
                ) : (
                  <>
                    {c.status === 'pending' && (c.author === 'web' || c.author === '') && (
                      <button className="icon-btn dep-remove" title="编辑评论（仅自己发的评论可编辑；编辑保存后重新唤醒 agent）"
                        onClick={e => {
                          e.stopPropagation();
                          setEditingComment(c.id);
                          setCommentDraft(c.body);
                        }}><Pencil size={12} /></button>
                    )}
                    <button className="icon-btn dep-remove" title="删除评论"
                      onClick={e => {
                        e.stopPropagation();
                        setConfirmingComment(c.id);
                        setTimeout(() => setConfirmingComment(cur => cur === c.id ? null : cur), 3000);
                      }}><X size={12} /></button>
                  </>
                )}
              </div>
              {editingComment === c.id ? (
                <form className="comment-edit" onSubmit={async ev => {
                  ev.preventDefault();
                  try {
                    await api_.updateComment(c.id, { body: commentDraft.trim() });
                    setEditingComment(null); onChanged(); await load();
                  } catch (err) { onToast(`✗ ${(err as Error).message}`); }
                }}>
                  <textarea rows={3} value={commentDraft} autoFocus
                    onChange={e => setCommentDraft(e.target.value)} />
                  <div className="comment-edit-row">
                    <button type="submit" className="btn tiny">保存并重新唤醒</button>
                    <button type="button" className="btn tiny ghost" onClick={() => setEditingComment(null)}>取消</button>
                  </div>
                </form>
              ) : (
              <Markdown src={c.body} />
              )}
            </li>))
          : <li style={{ color: 'var(--ink-dim)' }}>暂无评论</li>}
      </ul>
      {/* v0.4: 评论输入改自动增高 textarea——长文本自动换行，Enter 发送/Shift+Enter 换行 */}
      <form className="comment-form" onSubmit={async e => {
        e.preventDefault();
        if (!comment.trim()) return;
        try {
          await api_.addComment(detail.id, 'web', comment.trim());
          setComment(''); onChanged(); await load();
        } catch (err) { onToast(`✗ ${(err as Error).message}`); }
      }}>
        <textarea ref={commentInputRef} rows={2} value={comment}
          onChange={e => setComment(e.target.value)}
          onBlur={() => { if (mentionOpen) setMentionDismissed(true); }}
          onInput={e => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return; // IME 组合中不抢键（Enter 是组词提交）
            if (mentionOpen) {
              e.stopPropagation();
              if (e.key === 'ArrowDown') { e.preventDefault(); setMentionHi(h => nextHi(h, mentionHits.length, 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMentionHi(h => nextHi(h, mentionHits.length, -1)); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionHits[mentionHiSafe]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="添加评论…（@ 唤醒 agent，Enter 发送，Shift+Enter 换行）" />
        {/* 输入 @ 时弹出提及候选（chat 式补全面板）：↑↓ 高亮、Enter/Tab 选中、Esc 关闭；点击填入并保持输入框焦点。 */}
        {mentionOpen && (
          <span ref={mentionRef} className="mention-hint" role="listbox" aria-label="唤醒 agent 候选">
            {mentionHits.map((c, i) => (
              <button key={c.value} type="button" role="option" aria-selected={i === mentionHiSafe}
                className={`mention-opt${i === mentionHiSafe ? ' hi' : ''}`}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setMentionHi(i)}
                onClick={() => pickMention(c)}>
                <strong>{c.value}</strong><span>{c.label}</span>
              </button>
            ))}
          </span>
        )}
        <button className="btn tiny" type="submit">发送</button>
      </form>

      <details className="detail-section detail-disclosure detail-history">
        <summary>
          <span>活动</span>
          <span className="detail-summary-meta">{visibleActivities.length} 条</span>
        </summary>
        <ul className="activities">
          {visibleActivities.length
            ? visibleActivities.map(a => (
              <li key={a.id}>
                <span className="when">{fmtWhen(a.createdAt)}</span>
                <span className="who">{a.actor || 'anon'}</span>
                <span className="act">{a.action}</span>
                {a.detail && <span className="det">{a.detail}</span>}
              </li>))
            : <li style={{ color: 'var(--ink-dim)' }}>暂无活动</li>}
        </ul>
      </details>

      <details className="detail-section detail-disclosure detail-attachments">
        <summary>
          <span>附件</span>
          <span className="detail-summary-meta">{detail.attachments.length} 个</span>
        </summary>
        <label className="attachment-upload">
          <span>上传文件</span>
          <input type="file" className="attach-input" title="上传附件" onChange={e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            api_.uploadAttachment(detail.id, f)
              .then(a => { onToast(`已上传 ${a.filename}`); onChanged(); void load(); })
              .catch(err => onToast(`✗ ${(err as Error).message}`));
          }} />
        </label>
        <ul className="attachments">
          {detail.attachments.length
            ? detail.attachments.map(a => (
              <li key={a.id} title={`${a.filename} · ${a.size} B`}>
                <span className="att-name">📄 {a.filename}</span>
                <span className="att-meta">{humanSize(a.size)} · {a.actor || 'anon'} · {fmtWhen(a.createdAt)}</span>
                <a className="att-dl" href={api_.downloadUrl(a.id)} target="_blank" rel="noreferrer">下载</a>
              </li>))
            : <li style={{ color: 'var(--ink-dim)' }}>暂无附件</li>}
        </ul>
      </details>
    </aside>
    </>
  );
}
