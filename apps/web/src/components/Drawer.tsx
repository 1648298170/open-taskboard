import { useEffect, useState } from 'react';
import { api_, IssueDetail, Status } from '../api';

export function Drawer({ issueId, statuses, onClose, onChanged, onToast, onOpenIssue }: {
  issueId: string;
  statuses: readonly Status[];
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
  onOpenIssue: (id: string) => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [desc, setDesc] = useState('');
  const [comment, setComment] = useState('');

  const load = async (): Promise<void> => setDetail(await api_.showIssue(issueId));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [issueId]);

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
        <input style={{ width: 120 }} placeholder="分支" defaultValue={detail.branch}
          onBlur={e => { if (e.target.value !== detail.branch) void patch({ branch: e.target.value }); }} />
        <button className="btn tiny" style={{ color: 'var(--danger)' }} onClick={async () => {
          if (!confirm(`删除 #${detail.id} 及其子任务/评论？`)) return;
          await api_.deleteIssue(detail.id);
          onToast('已删除');
          onClose(); onChanged();
        }}>删除</button>
      </div>

      <h3>描述</h3>
      <textarea rows={8} value={desc || detail.description} onChange={e => setDesc(e.target.value)}
        onBlur={() => { if (desc && desc !== detail.description) void patch({ description: desc }); }} />

      <h3>子任务
        <button className="btn tiny" onClick={async () => {
          const title = prompt('子任务标题:');
          if (!title) return;
          await api_.createIssue(detail.projectId, { parentId: detail.id, title });
          onChanged(); await load();
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

      <h3>评论</h3>
      <ul className="comments">
        {detail.comments.length
          ? detail.comments.map(c => <li key={c.id}><span className="who">{c.author || 'anon'}</span>{c.body}</li>)
          : <li style={{ color: 'var(--ink-dim)' }}>暂无评论</li>}
      </ul>
      <form onSubmit={async e => {
        e.preventDefault();
        if (!comment.trim()) return;
        await api_.addComment(detail.id, 'web', comment.trim());
        setComment(''); onChanged(); await load();
      }}>
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="添加评论…" />
        <button className="btn tiny" type="submit">发送</button>
      </form>
    </aside>
  );
}
