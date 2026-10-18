import { FormEvent, useState } from 'react';
import { Select } from './Select';
import { api_, PRIORITIES, Priority } from '../api';

export function NewIssueDialog({ open, projectId, onClose, onCreated, onError }: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (parentId?: string) => void;
  onError: (msg: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>('medium');
  if (!open) return null;

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const parent = String(f.get('parent') ?? '').trim();
    const wake = f.get('wake') === 'on';
    try {
      const created = await api_.createIssue(projectId, {
        title: String(f.get('title')).trim(),
        parentId: parent || null,
        priority,
        branch: String(f.get('branch') ?? '').trim(),
        description: String(f.get('description') ?? '')
      });
      // v0.4: 创建后唤醒 —— UI 代发 @agent 评论，走现成 watch 链路把编排
      // 请求送达 agent 的 TUI 输入框。评论失败不阻塞创建（best-effort）。
      if (wake) {
        try {
          await api_.addComment(created.id, 'web', '@agent 如果主进程有任务正在处理，则请先把处理中的任务完成后，再认领此任务并编排（拆解子任务、排依赖）');
        } catch (err) {
          onError(`任务已创建，但唤醒失败：${(err as Error).message}`);
        }
      }
      form.reset();
      setPriority('medium');
      setError(null);
      onClose();
      onCreated(parent || undefined);
    } catch (err) {
      setError((err as Error).message);
      onError((err as Error).message);
    }
  };

  return (
    <dialog open className="new-dialog">
      <form onSubmit={submit}>
        <h2>新任务</h2>
        <label>标题<input name="title" required autoFocus /></label>
        <label>父任务 ID（可选，留空为顶层任务）<input name="parent" /></label>
        <div className="row">
          <label>优先级
            <Select value={priority} onChange={v => setPriority(v as Priority)}
              options={PRIORITIES.map(p => ({ value: p, label: p }))} />
          </label>
          <label>分支（可选）<input name="branch" /></label>
        </div>
        <label>描述<textarea name="description" rows={5} /></label>
        {/* v0.4: 创建后唤醒 agent（默认勾选）——替代手打 @agent 评论。 */}
        <label className="wake-check"><input type="checkbox" name="wake" defaultChecked /> 创建后唤醒 agent 编排</label>
        {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
        <menu>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary">创建</button>
        </menu>
      </form>
    </dialog>
  );
}
