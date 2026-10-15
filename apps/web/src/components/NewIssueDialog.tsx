import { FormEvent, useState } from 'react';
import { api_, Priority } from '../api';

export function NewIssueDialog({ open, projectId, onClose, onCreated, onError }: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (parentId?: string) => void;
  onError: (msg: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const parent = String(f.get('parent') ?? '').trim();
    try {
      await api_.createIssue(projectId, {
        title: String(f.get('title')).trim(),
        parentId: parent || null,
        priority: f.get('priority') as Priority,
        branch: String(f.get('branch') ?? '').trim(),
        description: String(f.get('description') ?? '')
      });
      form.reset();
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
            <select name="priority" defaultValue="medium">
              <option>low</option><option>medium</option><option>high</option><option>urgent</option>
            </select>
          </label>
          <label>分支（可选）<input name="branch" /></label>
        </div>
        <label>描述<textarea name="description" rows={5} /></label>
        {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
        <menu>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary">创建</button>
        </menu>
      </form>
    </dialog>
  );
}
