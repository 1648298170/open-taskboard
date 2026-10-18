import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computePosition, flip, shift } from '@floating-ui/dom';
import { activeClaim, api_, Commit, GitRefs, Issue, IssueDetail, PRIORITIES, Status } from '../api';
import { Markdown } from '../markdown';
import { confirmDialog, promptDialog } from './dialogs';
import { Select } from './Select';

/** ISO → "MM-DD HH:mm"（活动时间线用）。 */
const fmtWhen = (iso: string): string =>
  iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso;

/** T7-39: 字节数人性化（B / KB / MB）。 */
const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;

// 评论提及候选：与 watch 侧车默认唤醒前缀保持一致（taskboard watch --on 可改）。
const MENTION_CANDIDATES = ['@agent'];

export function Drawer({ issueId, projectId, statuses, onClose, onChanged, onToast, onOpenIssue, issues }: {
  issueId: string;
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refs, setRefs] = useState<GitRefs | null>(null);
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

  // 每次抽屉打开（组件挂载）拉一次 git-refs；失败静默回退为文本输入。
  useEffect(() => {
    if (!projectId) return;
    api_.gitRefs(projectId).then(setRefs).catch(() => setRefs(null));
  }, [projectId]);

  // T6-36: 绑定分支/工作树时预览最近提交（工作树优先——名字会被服务端
  // 解析成该工作树 checkout 的 HEAD）。换任务或换绑定即重取。
  const commitRef = detail ? (detail.worktree || detail.branch || '') : '';
  useEffect(() => {
    setCommits(null);
    if (!projectId || !commitRef) return;
    let stale = false;
    api_.commits(projectId, commitRef)
      .then(list => { if (!stale) setCommits(list); })
      .catch(() => { if (!stale) setCommits([]); });
    return () => { stale = true; };
  }, [projectId, commitRef]);

  if (loadError) {
    return (
      <aside className="drawer">
        <div className="drawer-head">
          <span className="issue-id">#{issueId}</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <p style={{ color: 'var(--danger)' }}>加载失败：{loadError}</p>
      </aside>
    );
  }
  if (!detail) return <aside className="drawer">加载中…</aside>;

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
    <aside className="drawer">
      <div className="drawer-head">
        <span className="issue-id">#{detail.id} · v{detail.version}</span>
        <button className="icon-btn" onClick={onClose}>✕</button>
      </div>
      <h2 contentEditable suppressContentEditableWarning
        onBlur={e => { const v = e.currentTarget.textContent?.trim(); if (v && v !== detail.title) void patch({ title: v }); }}>
        {detail.title}
      </h2>
      <div className="meta-row">
        <Select value={detail.status} onChange={v => void patch({ status: v as Status })}
          options={statuses.map(st => ({ value: st, label: st }))} />
        <Select value={detail.priority} onChange={v => void patch({ priority: v as IssueDetail['priority'] })}
            options={PRIORITIES.map(pr => ({ value: pr, label: pr }))} />
        {/* 负责人 / 标签：与分支回退输入同款模式（defaultValue + 失焦提交），
            此前这两个字段只能经 CLI/MCP 修改，面板上看得到改不了。 */}
        <input title="负责人" placeholder="负责人" defaultValue={detail.assignee}
          onBlur={e => { const v = e.target.value.trim(); if (v !== detail.assignee) void patch({ assignee: v }); }} />
        {/* v0.4: opencode 会话绑定（@agent 唤醒续此会话）。 */}
        <input title="opencode 会话绑定（@agent 唤醒续此会话）" placeholder="ses_…"
          defaultValue={detail.sessionId ?? ''}
          onBlur={e => { const v = e.target.value.trim() || null; if (v !== detail.sessionId) void patch({ sessionId: v }); }} />
        <input title="标签（逗号分隔）" placeholder="标签,逗号分隔" defaultValue={detail.labels}
          onBlur={e => { const v = e.target.value.trim(); if (v !== detail.labels) void patch({ labels: v }); }} />
        {/* T2-8: 有 git-refs 数据时分支用下拉（保留当前值即使不在列表中），
            拉不到数据回退为原文本输入；改动走与原输入相同的乐观锁 patch。 */}
        {refs && refs.branches.length > 0 ? (
          <Select title="分支" value={detail.branch}
            onChange={v => { if (v !== detail.branch) void patch({ branch: v }); }}
            options={[{ value: '', label: '分支 —' },
              ...(detail.branch && !refs.branches.includes(detail.branch) ? [{ value: detail.branch, label: detail.branch }] : []),
              ...refs.branches.map(b => ({ value: b, label: b }))]} />
        ) : (
          <input placeholder="分支" defaultValue={detail.branch}
            onBlur={e => { if (e.target.value !== detail.branch) void patch({ branch: e.target.value }); }} />
        )}
        {/* T2-8: 工作树字段，同样的下拉/回退模式（值为 worktree 名称）。 */}
        {refs && refs.worktrees.length > 0 ? (
          <Select title="工作树" value={detail.worktree}
            onChange={v => { if (v !== detail.worktree) void patch({ worktree: v }); }}
            options={[{ value: '', label: '工作树 —' },
              ...(detail.worktree && !refs.worktrees.some(w => w.name === detail.worktree) ? [{ value: detail.worktree, label: detail.worktree }] : []),
              ...refs.worktrees.map(w => ({ value: w.name, label: w.name }))]} />
        ) : (
          <input placeholder="工作树" defaultValue={detail.worktree}
            onBlur={e => { if (e.target.value !== detail.worktree) void patch({ worktree: e.target.value }); }} />
        )}
        <input type="date" title="开始日期" defaultValue={detail.startDate ?? ''}
          onChange={e => { const v = e.target.value || null; if (v !== detail.startDate) void patch({ startDate: v }); }} />
        <input type="date" title="截止日期" defaultValue={detail.dueDate ?? ''}
          onChange={e => { const v = e.target.value || null; if (v !== detail.dueDate) void patch({ dueDate: v }); }} />
        <button className="btn tiny" style={{ color: 'var(--danger)' }} onClick={async () => {
          if (!await confirmDialog({ title: `删除 #${detail.id} 及其子任务/评论？`, danger: true, confirmText: '删除' })) return;
          try {
            await api_.deleteIssue(detail.id);
            onToast('已删除');
            onClose(); onChanged();
          } catch (err) { onToast(`✗ ${(err as Error).message}`); }
        }}>删除</button>
        {/* T5-24: 归档。done 后可选（暗色弱化样式，confirm 双击保护——与删除一致）；
            已归档的任务显示「取消归档」。归档后从看板消失 → 关抽屉。 */}
        {detail.archivedAt
          ? <button className="btn tiny" onClick={async () => {
              try {
                await api_.unarchiveIssue(detail.id);
                onToast('已取消归档');
                onChanged(); await load();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>取消归档</button>
          : detail.status === 'done' && (
            <button className="btn tiny" style={{ color: 'var(--ink-dim)' }} onClick={async () => {
              if (!await confirmDialog({ title: `归档 #${detail.id}？`, lines: ['将从看板移除（可随时取消归档）'], confirmText: '归档' })) return;
              try {
                await api_.archiveIssue(detail.id);
                onToast('已归档');
                onClose(); onChanged();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>归档</button>
          )}
        {/* v0.4: 一键唤醒 —— UI 代发 @agent 评论（web 来源，人工触发），
            watch 捕获后把编排请求送达 agent 的 TUI 输入框。done 任务无编排意义。 */}
        {detail.status !== 'done' && (
          <button className="btn tiny" style={{ color: 'var(--accent)' }} title="唤醒 agent 编排此任务（评论 @agent，经 watch 送达 TUI）"
            onClick={async () => {
              try {
                await api_.addComment(detail.id, 'web', '@agent 请认领此任务并编排（拆解子任务、排依赖）');
                onToast('已唤醒 agent——watch 会把请求送达 TUI 输入框，回车即开工');
                onChanged();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>🤖 唤醒</button>
        )}
        {/* T7-34: 认领/释放（以 agent 'web' 操作，紧挨归档）。有效租约显示
            认领徽章 + 释放；无租约显示认领。他人持有的租约释放会 409 → toast。 */}
        {activeClaim(detail) !== null
          ? <button className="btn tiny" style={{ color: 'var(--accent)' }} onClick={async () => {
              try {
                await api_.releaseIssue(detail.id);
                onToast(`#${detail.id} 已释放租约`);
                onChanged(); await load();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>释放</button>
          : <button className="btn tiny" style={{ color: 'var(--accent)' }} onClick={async () => {
              try {
                const claimed = await api_.claimIssue(detail.id);
                onToast(`#${detail.id} 已认领，租约至 ${claimed.leaseExpiresAt?.slice(11, 16) ?? ''}`);
                onChanged(); await load();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>认领</button>}
      </div>

      {/* T7-34: 认领信息（meta 行下单独一行，含续租）。仅有效租约显示。 */}
      {(() => {
        const holder = activeClaim(detail);
        if (holder === null || detail.leaseExpiresAt === null) return null;
        const minutes = Math.max(0, Math.ceil((Date.parse(detail.leaseExpiresAt) - Date.now()) / 60_000));
        return (
          <div className="claim-info">
            <span className="claim-badge">👤 {holder} · 剩余 {minutes}m（至 {detail.leaseExpiresAt.slice(11, 16)}）</span>
            {holder === 'web' && (
              <button className="btn tiny" onClick={async () => {
                try {
                  const beat = await api_.heartbeatIssue(detail.id);
                  onToast(`#${detail.id} 续租成功，至 ${beat.leaseExpiresAt?.slice(11, 16) ?? ''}`);
                  onChanged(); await load();
                } catch (err) { onToast(`✗ ${(err as Error).message}`); }
              }}>续租</button>
            )}
          </div>
        );
      })()}

      {/* T6-36: 最近提交预览 —— 绑定了分支或工作树才显示。 */}
      {commitRef && (
        <>
          <h3>最近提交{commits && commits.length > 0 ? ` (${commitRef})` : ''}</h3>
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
        </>
      )}

      <h3>描述
        {!editingDesc && <button className="btn tiny" onClick={() => setEditingDesc(true)}>✎ 编辑</button>}
      </h3>
      {editingDesc
        ? <textarea rows={8} autoFocus value={desc || detail.description} onChange={e => setDesc(e.target.value)}
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
        }}>＋ 拆解子任务</button>
      </h3>
      <ul className="children">
        {detail.children.length
          ? detail.children.map(c => (
            <li key={c.id} onClick={() => onOpenIssue(c.id)}>
              <span className="st">[{c.status}]</span>{c.title}
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
              .map(c => ({ value: c.id, label: `#${c.id} ${c.title} [${c.status}]` })),
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
                {onRemove && <button className="icon-btn dep-remove" title="移除依赖"
                  onClick={e => { e.stopPropagation(); void onRemove(); }}>✕</button>}
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

      <h3>评论</h3>
      <ul className="comments">
        {detail.comments.length
          ? detail.comments.map(c => (
            <li key={c.id}>
              {/* v0.4: 头行（作者+删除）与正文分层——正文独立整行，长文不再绕排 */}
              <div className="comment-head">
                <span className="who">{c.author || 'anon'}</span>
                <button className="icon-btn dep-remove" title="删除评论"
                  onClick={async e => {
                    e.stopPropagation();
                    if (!await confirmDialog({ title: '删除这条评论？', danger: true, confirmText: '删除' })) return;
                    try {
                      await api_.deleteComment(c.id);
                      onChanged(); await load();
                    } catch (err) { onToast(`✗ ${(err as Error).message}`); }
                  }}>✕</button>
              </div>
              <Markdown src={c.body} />
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
          onInput={e => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="添加评论…（@ 唤醒 agent，Enter 发送，Shift+Enter 换行）" />
        {/* 输入 @ 时弹出提及候选（chat 式）；点击填入。发送逻辑不变。 */}
        {(() => {
          const frag = /^@([\w-]*)$/.exec(comment.trim());
          if (!frag) return null;
          const hits = MENTION_CANDIDATES.filter(m => m.startsWith(`@${frag[1]}`) && m !== comment.trim());
          if (hits.length === 0) return null;
          return (
            <span ref={mentionRef} className="mention-hint">
              {hits.map(m => (
                <button key={m} type="button" className="btn tiny" title="点击填入；watch 侧车运行时将唤醒 agent"
                  onClick={() => setComment(m + ' ')}>{m} 唤醒侧车</button>
              ))}
            </span>
          );
        })()}
        <button className="btn tiny" type="submit">发送</button>
      </form>

      <h3>活动</h3>
      <ul className="activities">
        {detail.activities.length
          ? detail.activities.map(a => (
            <li key={a.id}>
              <span className="when">{fmtWhen(a.createdAt)}</span>
              <span className="who">{a.actor || 'anon'}</span>
              <span className="act">{a.action}</span>
              {a.detail && <span className="det">{a.detail}</span>}
            </li>))
          : <li style={{ color: 'var(--ink-dim)' }}>暂无活动</li>}
      </ul>

      {/* T7-39: 附件 —— 列表（下载直链，令牌走 ?token=，与 SSE 同法）+ 本地上传。 */}
      <h3>附件
        <input type="file" className="attach-input" title="上传附件" onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = ''; // 允许重复选择同一文件再次上传
          if (!f) return;
          api_.uploadAttachment(detail.id, f)
            .then(a => { onToast(`已上传 ${a.filename}`); onChanged(); void load(); })
            .catch(err => onToast(`✗ ${(err as Error).message}`));
        }} />
      </h3>
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
    </aside>
  );
}
