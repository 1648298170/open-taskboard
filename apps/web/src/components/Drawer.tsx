import { useEffect, useState } from 'react';
import { api_, Commit, GitRefs, Issue, IssueDetail, Status } from '../api';
import { renderMarkdown } from '../markdown';

/** ISO → "MM-DD HH:mm"（活动时间线用）。 */
const fmtWhen = (iso: string): string =>
  iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso;

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
        <select value={detail.status} onChange={e => void patch({ status: e.target.value as Status })}>
          {statuses.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={detail.priority} onChange={e => void patch({ priority: e.target.value as IssueDetail['priority'] })}>
          {(['low', 'medium', 'high', 'urgent'] as const).map(p => <option key={p}>{p}</option>)}
        </select>
        {/* T2-8: 有 git-refs 数据时分支用下拉（保留当前值即使不在列表中），
            拉不到数据回退为原文本输入；改动走与原输入相同的乐观锁 patch。 */}
        {refs && refs.branches.length > 0 ? (
          <select style={{ width: 120 }} title="分支" value={detail.branch}
            onChange={e => { if (e.target.value !== detail.branch) void patch({ branch: e.target.value }); }}>
            <option value="">分支 —</option>
            {detail.branch && !refs.branches.includes(detail.branch) &&
              <option value={detail.branch}>{detail.branch}</option>}
            {refs.branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : (
          <input style={{ width: 120 }} placeholder="分支" defaultValue={detail.branch}
            onBlur={e => { if (e.target.value !== detail.branch) void patch({ branch: e.target.value }); }} />
        )}
        {/* T2-8: 工作树字段，同样的下拉/回退模式（值为 worktree 名称）。 */}
        {refs && refs.worktrees.length > 0 ? (
          <select style={{ width: 120 }} title="工作树" value={detail.worktree}
            onChange={e => { if (e.target.value !== detail.worktree) void patch({ worktree: e.target.value }); }}>
            <option value="">工作树 —</option>
            {detail.worktree && !refs.worktrees.some(w => w.name === detail.worktree) &&
              <option value={detail.worktree}>{detail.worktree}</option>}
            {refs.worktrees.map(w => <option key={w.path} value={w.name} title={w.path}>{w.name}</option>)}
          </select>
        ) : (
          <input style={{ width: 120 }} placeholder="工作树" defaultValue={detail.worktree}
            onBlur={e => { if (e.target.value !== detail.worktree) void patch({ worktree: e.target.value }); }} />
        )}
        <input type="date" title="开始日期" defaultValue={detail.startDate ?? ''}
          onChange={e => { const v = e.target.value || null; if (v !== detail.startDate) void patch({ startDate: v }); }} />
        <input type="date" title="截止日期" defaultValue={detail.dueDate ?? ''}
          onChange={e => { const v = e.target.value || null; if (v !== detail.dueDate) void patch({ dueDate: v }); }} />
        <button className="btn tiny" style={{ color: 'var(--danger)' }} onClick={async () => {
          if (!confirm(`删除 #${detail.id} 及其子任务/评论？`)) return;
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
              if (!confirm(`归档 #${detail.id}？将从看板移除（可随时取消归档）`)) return;
              try {
                await api_.archiveIssue(detail.id);
                onToast('已归档');
                onClose(); onChanged();
              } catch (err) { onToast(`✗ ${(err as Error).message}`); }
            }}>归档</button>
          )}
      </div>

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
          ? <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.description) }} />
          : <p style={{ color: 'var(--ink-dim)', fontSize: 12 }}>暂无描述</p>}

      <h3>子任务
        <button className="btn tiny" onClick={async () => {
          const title = prompt('子任务标题:');
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

      <h3>依赖
        <button className="btn tiny" onClick={async () => {
          const depId = prompt('被哪个任务阻塞？（输入任务 ID，如 ab12cd34）:')?.trim();
          if (!depId) return;
          try {
            await api_.addDependency(detail.id, depId);
            onToast(`#${detail.id} 被 #${depId} 阻塞`);
            onChanged(); await load();
          } catch (err) { onToast(`✗ ${(err as Error).message}`); }
        }}>＋ 添加依赖</button>
      </h3>
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
              <span className="who">{c.author || 'anon'}</span>
              <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
            </li>))
          : <li style={{ color: 'var(--ink-dim)' }}>暂无评论</li>}
      </ul>
      <form onSubmit={async e => {
        e.preventDefault();
        if (!comment.trim()) return;
        try {
          await api_.addComment(detail.id, 'web', comment.trim());
          setComment(''); onChanged(); await load();
        } catch (err) { onToast(`✗ ${(err as Error).message}`); }
      }}>
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="添加评论…" />
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
    </aside>
  );
}
