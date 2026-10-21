import { FormEvent, useEffect, useState } from 'react';
import { Select } from './Select';
import { ParentCombobox } from './ParentCombobox';
import { api_, Issue, PRIORITIES, Priority } from '../api';
import { WAKE_PREFIX } from '@taskboard/core/types';

export function NewIssueDialog({ open, projectId, workspacePath, issues = [], onClose, onCreated, onError }: {
  open: boolean;
  projectId: string;
  workspacePath?: string;
  issues?: Issue[];
  onClose: () => void;
  onCreated: (parentId?: string) => void;
  onError: (msg: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>('medium');
  const [parentId, setParentId] = useState('');
  const [parentReset, setParentReset] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setParentId('');
      setParentReset(n => n + 1);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const parent = parentId.trim();
    const wake = f.get('wake') === 'on';
    setSaving(true);
    try {
      const created = await api_.createIssue(projectId, {
        title: String(f.get('title')).trim(),
        parentId: parent || null,
        priority,
        description: String(f.get('description') ?? '')
      });
      // Wake follows the normal Agent queue; the task itself never binds a Session.
      if (wake) {
        try { await api_.addComment(created.id, 'web', `${WAKE_PREFIX} 认领此任务并编排（拆解子任务、排依赖）`); }
        catch (err) { onError(`任务已创建，但唤醒失败：${(err as Error).message}`); }
      }
      form.reset();
      setPriority('medium');
      setParentId('');
      setParentReset(n => n + 1);
      setError(null);
      onClose();
      onCreated(parent || undefined);
    } catch (err) {
      setError((err as Error).message);
      onError((err as Error).message);
    } finally { setSaving(false); }
  };

  return (
    <dialog open className="new-dialog new-issue-dialog">
      <form className="new-issue-form" onSubmit={submit}>
        <div className="dialog-heading">
          <span className="dialog-eyebrow">TASK</span>
          <h2>新建任务</h2>
          <p>任务自动继承项目默认 Session 和所属目录的工作目录，不需要单独设置执行环境。</p>
        </div>
        {workspacePath && <p className="session-hint">工作目录 · {workspacePath}</p>}
        <label>标题<input name="title" required autoFocus placeholder="一句话讲清楚要做什么" /></label>
        <label>父任务（可选，留空为顶层任务）
          <ParentCombobox issues={issues} value={parentId} onChange={id => { setParentId(id); setError(null); }}
            resetSignal={parentReset} placeholder="输入或选择父任务，如 a1b2c3d4" ariaLabel="父任务" />
        </label>
        <label>优先级
          <Select value={priority} onChange={v => setPriority(v as Priority)} options={PRIORITIES.map(p => ({ value: p, label: p }))} />
        </label>
        <label>描述<textarea name="description" rows={5} placeholder="背景 / 验收标准 / 注意事项（Markdown）" /></label>
        <label className="wake-check"><input type="checkbox" name="wake" defaultChecked /> 创建后唤醒 Agent 编排</label>
        {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
        <menu>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? '创建中…' : '创建'}</button>
        </menu>
      </form>
    </dialog>
  );
}