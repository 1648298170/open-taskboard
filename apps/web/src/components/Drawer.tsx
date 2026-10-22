import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computePosition, flip, shift } from '@floating-ui/dom';
import { activeClaim, api_, Commit, Issue, IssueDetail, PRIORITIES, STATUS_CN, Status } from '../api';
import { Markdown } from '../markdown';
import { confirmDialog, promptDialog } from './dialogs';
import { fmtHMLocal, fmtWhenLocal } from '../logic/time';
import { applyMentionAt, detectMentionAt, mentionCandidatesFor, MentionCandidate, nextHi } from '../logic/mention';
import { shouldSkipRefresh } from '../logic/mutationDedupe';
import { Copy, Pencil, Plus, Sparkles, UserRound, X } from 'lucide-react';
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

export function Drawer({ issueId, projectId, refreshKey, statuses, onClose, onChanged, onToast, onOpenIssue, issues, commentAuthor, onOpenSession }: {
  issueId: string;
  commentAuthor: string;
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
  /** 打开内嵌会话面板（App 层持有面板状态） */
  onOpenSession: (url: string, sessionId: string | null, title: string) => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [desc, setDesc] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [comment, setComment] = useState('');
  // v0.4: 评论删除两步内联确认——✕ 点击后变「确认删除」，3s 不点自动还原（无弹窗）。
  const [confirmingComment, setConfirmingComment] = useState<string | null>(null);
  const [confirmingAttachment, setConfirmingAttachment] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  // v0.4: 依赖边移除同款两步内联确认（全局删除必须有二次确认）。
  const [confirmingDep, setConfirmingDep] = useState<string | null>(null);
  // v0.4: mention 候选浮层 —— floating-ui 定位（跟随输入框，翻转+防溢出）。
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<HTMLSpanElement>(null);
  // 补全作用于哪个输入框（新评论 / 编辑框）与光标处的 @fragment（任意位置输入 @ 触发）。
  const [mentionBox, setMentionBox] = useState<'new' | 'edit' | null>(null);
  const [mentionCtx, setMentionCtx] = useState<{ start: number; fragment: string } | null>(null);
  const [mentionHi, setMentionHi] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const updateMentionFromCaret = (box: 'new' | 'edit', text: string, caret: number | null): void => {
    const ctx = detectMentionAt(text, caret ?? text.length);
    if (ctx) {
      setMentionBox(box); setMentionCtx(ctx); setMentionDismissed(false); setMentionHi(0);
    } else {
      setMentionBox(null); setMentionCtx(null);
    }
  };
  const mentionHits = mentionBox !== null && mentionCtx
    ? mentionCandidatesFor(mentionCtx.fragment, MENTION_CANDIDATES)
    : [];
  const mentionOpen = mentionBox !== null && mentionCtx !== null && mentionHits.length > 0 && !mentionDismissed;
  const mentionHiSafe = Math.min(mentionHi, Math.max(mentionHits.length - 1, 0));
  const mentionAnchor = mentionBox === 'edit' ? editInputRef : commentInputRef;
  useLayoutEffect(() => {
    if (!mentionOpen || !mentionAnchor.current || !mentionRef.current) return;
    void computePosition(mentionAnchor.current, mentionRef.current, {
      placement: 'bottom-start', strategy: 'fixed', middleware: [flip(), shift()]
    }).then(({ x, y }) => {
      if (mentionRef.current) {
        mentionRef.current.style.left = `${x}px`;
        mentionRef.current.style.top = `${y}px`;
      }
    });
  });
  const pickMention = (c: MentionCandidate): void => {
    if (mentionBox === null || mentionCtx === null) return;
    const applied = applyMentionAt(
      mentionBox === 'edit' ? commentDraft : comment,
      mentionCtx.start, c.value
    );
    if (mentionBox === 'edit') setCommentDraft(applied.text);
    else setComment(applied.text);
    requestAnimationFrame(() => {
      const el = mentionBox === 'edit' ? editInputRef.current : commentInputRef.current;
      if (el) { el.selectionStart = el.selectionEnd = applied.caret; el.focus(); }
    });
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  // T6-36: 最近提交预览。null = 加载中/不可用。
  const [commits, setCommits] = useState<Commit[] | null>(null);

  // 一键复制任务 ID（粘贴到 CLI / MCP 时直接用原始 id）。
  const copyIssueId = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      onToast(`已复制任务 ID：${id}`);
    } catch {
      onToast('✗ 复制失败，请手动选择复制');
    }
  };

  // 本地变更后的 load() 与服务端 issue.updated 的 SSE 回声会在毫秒内各取一次
  // /api/issues/{id}；同任务 300ms 窗口内只保留第一次（本地主动刷新）。
  const lastLoadRef = useRef<{ at: number; issueId: string }>({ at: 0, issueId: '' });
  const load = async (): Promise<void> => {
    const now = Date.now();
    if (lastLoadRef.current.issueId === issueId && shouldSkipRefresh(lastLoadRef.current.at, now)) return;
    lastLoadRef.current = { at: now, issueId };
    try {
      setDetail(await api_.showIssue(issueId));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };
  // 只在 refreshKey 真正变化时重取：effect 挂载时也会跑一次，而 refreshKey
  // 通常已 >0，直接 load 会让每次打开抽屉都请求两次 /api/issues/{id}。
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => { setDetail(null); setDesc(''); setEditingDesc(false); setLoadError(null); lastRefreshKey.current = refreshKey; void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [issueId]);
  useEffect(() => {
    if (refreshKey === lastRefreshKey.current) return;
    lastRefreshKey.current = refreshKey;
    void load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [refreshKey]);

  // T6-36: 绑定分支/工作树时预览最近提交（工作树优先——名字会被服务端
  // 解析成该工作树 checkout 的 HEAD）。换任务或换绑定即重取。
  const commitRef = detail ? (detail.worktree || detail.branch || '') : '';
  const visibleActivities = detail ? detail.activities : [];
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
      <div className="drawer-head-id">
        <span className="issue-id">#{issueId}{detail ? ` · v${detail.version}` : ' · 加载中'}</span>
        <button className="icon-btn" title="复制任务 ID" aria-label="复制任务 ID"
          onClick={() => void copyIssueId(issueId)}><Copy size={13} /></button>
      </div>
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

  const depCount = (detail.blockedBy?.length ?? 0) + (detail.blocks?.length ?? 0);
  const doneChildren = detail.children.filter(c => c.status === 'done').length;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
      <div className="drawer-head">
        <div className="drawer-head-id">
          <span className="issue-id">#{detail.id} · v{detail.version}</span>
          <button className="icon-btn" title="复制任务 ID" aria-label="复制任务 ID"
            onClick={() => void copyIssueId(detail.id)}><Copy size={13} /></button>
        </div>
        <button className="icon-btn" onClick={onClose}><X size={16} /></button>
      </div>

      {/* 概览区：标题、状态/优先级、负责人、日期——打开抽屉第一眼要看到的信息。 */}
      <div className="detail-overview">
        <h2 className="task-detail-title" contentEditable suppressContentEditableWarning
          onBlur={e => { const v = e.currentTarget.textContent?.trim(); if (v && v !== detail.title) void patch({ title: v }); }}>
          {detail.title}
        </h2>
        {/* 一行一个属性：标签在左、控件靠右（参考 TaskDetail 的属性行结构）。 */}
        <div className="detail-property-list" aria-label="任务属性">
          <div className="detail-property-row">
            <span className="detail-property-label" id="drawer-prop-status">状态</span>
            <div className="detail-property-control">
              <Select value={detail.status} ariaLabel="状态" onChange={v => void patch({ status: v as Status })}
                options={statuses.map(st => ({ value: st, label: STATUS_CN[st] ?? st }))} />
            </div>
          </div>
          <div className="detail-property-row">
            <span className="detail-property-label" id="drawer-prop-assignee">负责人</span>
            <div className="detail-property-control">
              <span className={`detail-property-value${detail.assignee ? '' : ' is-empty'}`}
                title="负责人由 Agent 维护" aria-labelledby="drawer-prop-assignee">
                <UserRound size={13} /> {detail.assignee ? `@${detail.assignee}` : '未分配'}
              </span>
            </div>
          </div>
          <div className="detail-property-row">
            <span className="detail-property-label" id="drawer-prop-priority">优先级</span>
            <div className="detail-property-control">
              <Select value={detail.priority} ariaLabel="优先级"
                onChange={v => void patch({ priority: v as IssueDetail['priority'] })}
                options={PRIORITIES.map(pr => ({ value: pr, label: pr }))} />
            </div>
          </div>
          <div className="detail-property-row">
            <label className="detail-property-label" htmlFor="drawer-start-date">计划开始</label>
            <div className="detail-property-control">
                        <input id="drawer-start-date" key={`${detail.id}-start`} type="date" title="计划开始日期" defaultValue={detail.startDate ?? ''}
                onChange={e => { const v = e.target.value || null; if (v !== detail.startDate) void patch({ startDate: v }); }} />
            </div>
          </div>
          <div className="detail-property-row">
            <label className="detail-property-label" htmlFor="drawer-due-date">截止日期</label>
            <div className="detail-property-control">
                        <input id="drawer-due-date" key={`${detail.id}-due`} type="date" title="截止日期" defaultValue={detail.dueDate ?? ''}
                onChange={e => { const v = e.target.value || null; if (v !== detail.dueDate) void patch({ dueDate: v }); }} />
            </div>
          </div>
        </div>

        <div className="detail-actions detail-primary-actions">
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
          {detail.sessionUrl && (
            <button className="btn tiny" onClick={() => onOpenSession(detail.sessionUrl, detail.sessionId, detail.title)}>打开会话</button>
          )}
          {detail.status !== 'done' && (
            <button className="btn tiny detail-wake-action"
              title={detail.sessionId
                ? `唤醒 agent：继续绑定会话 ${detail.sessionId}`
                : '唤醒 agent：按项目路由发送或创建新会话'}
              onClick={async () => {
                // 内嵌会话面板由 App 层持有；这里只负责把面板打开（唤醒评论随后入队）。
                if (detail.sessionUrl) {
                  onOpenSession(detail.sessionUrl, detail.sessionId, detail.title);
                }
                try {
                  const created = await api_.addComment(detail.id, `${WAKE_PREFIX} 认领此任务并编排（拆解子任务、排依赖）`);
                  onToast(detail.sessionId
                    ? `已入队——watch 将投递到绑定会话 ${detail.sessionId}`
                    : '已入队——watch 将按项目路由送达或新建 headless 会话');
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

        <section className="detail-description" aria-labelledby="drawer-description-heading">
          <div className="detail-block-head">
            <h3 id="drawer-description-heading">描述</h3>
            {!editingDesc && <button className="btn tiny" onClick={() => setEditingDesc(true)}><Pencil size={12} /> 编辑</button>}
          </div>
          {editingDesc
            ? <textarea rows={8} autoFocus placeholder="任务描述（Markdown）" value={desc || detail.description} onChange={e => setDesc(e.target.value)}
                onBlur={() => {
                  if (desc && desc !== detail.description) void patch({ description: desc });
                  setEditingDesc(false);
                }} />
            : detail.description
              ? <Markdown src={detail.description} />
              : <p style={{ color: 'var(--ink-dim)', fontSize: 12 }}>暂无描述</p>}
        </section>
      </div>

      {/* 评论紧跟概览：最高频的协作入口，打开即可写。 */}
      <section className="drawer-section drawer-comments" aria-labelledby="drawer-comments-heading">
        <h3 className="drawer-section-head" id="drawer-comments-heading">评论
          {detail.comments.length > 0 && <span className="drawer-count">{detail.comments.length}</span>}
        </h3>
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
                      {(c.status === 'pending' || c.status === 'processing') && c.body.trimStart().startsWith(WAKE_PREFIX) && (
                        <button className="icon-btn dep-remove" title="重新唤醒：重新入队并投递到绑定会话"
                          onClick={async e => {
                            e.stopPropagation();
                            try {
                              await api_.updateComment(c.id, { status: 'pending' });
                              onToast('已重新入队，引擎将重新投递');
                              onChanged(); await load();
                            } catch (err) { onToast(`✗ ${(err as Error).message}`); }
                          }}><Sparkles size={12} /></button>
                      )}
                      {c.status === 'pending' && (c.author === commentAuthor || (commentAuthor === 'web' && c.author === '')) && (
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
                    <textarea ref={editInputRef} rows={3} value={commentDraft} autoFocus
                      onChange={e => {
                        const el = e.currentTarget;
                        setCommentDraft(el.value);
                        updateMentionFromCaret('edit', el.value, el.selectionStart);
                      }}
                      onBlur={() => { if (mentionOpen && mentionBox === 'edit') setMentionDismissed(true); }}
                      onKeyDown={e => {
                        if (e.nativeEvent.isComposing) return;
                        if (mentionOpen && mentionBox === 'edit') {
                          e.stopPropagation();
                          if (e.key === 'ArrowDown') { e.preventDefault(); setMentionHi(h => nextHi(h, mentionHits.length, 1)); return; }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setMentionHi(h => nextHi(h, mentionHits.length, -1)); return; }
                          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionHits[mentionHiSafe]); return; }
                          if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return; }
                        }
                      }} />
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
            await api_.addComment(detail.id, comment.trim());
            setComment(''); onChanged(); await load();
          } catch (err) { onToast(`✗ ${(err as Error).message}`); }
        }}>
          <textarea ref={commentInputRef} rows={2} value={comment}
            onChange={e => {
              const el = e.currentTarget;
              setComment(el.value);
              updateMentionFromCaret('new', el.value, el.selectionStart);
            }}
            onBlur={() => { if (mentionOpen && mentionBox === 'new') setMentionDismissed(true); }}
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
      </section>

      <section className="drawer-section" aria-labelledby="drawer-children-heading">
        <h3 className="drawer-section-head" id="drawer-children-heading">子任务
          {detail.children.length > 0 && <span className="drawer-count">{doneChildren}/{detail.children.length}</span>}
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
      </section>

      <section className="drawer-section" aria-labelledby="drawer-deps-heading">
        <h3 className="drawer-section-head" id="drawer-deps-heading">依赖
          {depCount > 0 && <span className="drawer-count">{depCount}</span>}
        </h3>
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
      </section>

      <section className="drawer-section drawer-attachments" aria-labelledby="drawer-attachments-heading">
        <h3 className="drawer-section-head" id="drawer-attachments-heading">附件
          {detail.attachments.length > 0 && <span className="drawer-count">{detail.attachments.length}</span>}
        </h3>
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
                {confirmingAttachment === a.id ? (
                  <button className="btn tiny danger" title="再次点击确认删除附件"
                    onClick={async e => {
                      e.stopPropagation();
                      setConfirmingAttachment(null);
                      try {
                        await api_.deleteAttachment(a.id);
                        onToast(`已删除附件：${a.filename}`);
                        onChanged(); void load();
                      } catch (err) { onToast(`✗ ${(err as Error).message}`); }
                    }}>确认删除</button>
                ) : (
                  <button className="icon-btn dep-remove" title="删除附件"
                    onClick={e => {
                      e.stopPropagation();
                      setConfirmingAttachment(a.id);
                      setTimeout(() => setConfirmingAttachment(cur => cur === a.id ? null : cur), 3000);
                    }}><X size={12} /></button>
                )}
              </li>))
            : <li style={{ color: 'var(--ink-dim)' }}>暂无附件</li>}
        </ul>
      </section>

      <section className="drawer-section drawer-history" aria-labelledby="drawer-activity-heading">
        <h3 className="drawer-section-head" id="drawer-activity-heading">活动
          {visibleActivities.length > 0 && <span className="drawer-count">{visibleActivities.length}</span>}
        </h3>
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
      </section>

      {/* 详情：低频属性收进原生折叠区；工作树/工作树路径与审核结论/意见不再展示。 */}
      <details className="drawer-section drawer-fold drawer-details">
        <summary className="drawer-section-head">
          <span>详情</span>
          <span className="drawer-fold-meta">{detail.branch || '无分支'}</span>
        </summary>
        <div className="drawer-details-body">
          <div className="detail-fact-list">
            <label className="detail-fact-row detail-fact-row-edit">
              <span>标签</span>
              <input title="标签（逗号分隔）" placeholder="以逗号分隔" defaultValue={detail.labels}
                onBlur={e => { const v = e.target.value.trim(); if (v !== detail.labels) void patch({ labels: v }); }} />
            </label>
            <div className="detail-fact-row"><span>任务 ID</span><code>{detail.id}</code></div>
            <div className="detail-fact-row"><span>Git 分支</span><code>{detail.branch || '—'}</code></div>
            <div className="detail-fact-row"><span>Session</span><code title={detail.sessionId ?? undefined}>{detail.sessionId || '未配置项目默认 Session'}</code></div>
            <div className="detail-fact-row"><span>创建时间</span><code>{fmtWhen(detail.createdAt)}</code></div>
            <div className="detail-fact-row"><span>更新时间</span><code>{fmtWhen(detail.updatedAt)}</code></div>
          </div>
          <label className="detail-fact-field">
            <span>验收标准（Markdown）</span>
            <textarea rows={4} defaultValue={detail.acceptanceCriteria}
              placeholder="列出可验证的完成条件，例如：功能行为、边界情况、测试要求…"
              onBlur={e => {
                const value = e.currentTarget.value;
                if (value !== detail.acceptanceCriteria) void patch({ acceptanceCriteria: value });
              }} />
          </label>
          {/* T6-36: 最近提交预览 —— 绑定了分支或工作树才显示。 */}
          {commitRef && (
            <div className="detail-commits">
              <div className="detail-commits-head">
                <span>最近提交</span>
                <span className="drawer-fold-meta">{commits === null ? '读取中' : `${commits.length} 条`}</span>
              </div>
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
            </div>
          )}
        </div>
      </details>
    </aside>
    </>
  );
}
