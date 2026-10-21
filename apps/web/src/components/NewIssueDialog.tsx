import { FormEvent, useEffect, useState } from 'react';
import { Select } from './Select';
import { ParentCombobox } from './ParentCombobox';
import { api_, Issue, PRIORITIES, Priority } from '../api';
import { WAKE_PREFIX } from '@taskboard/core/types';

export function NewIssueDialog({ open, projectId, workspacePath, defaultSessionId, issues = [], onClose, onCreated, onError }: {
  open: boolean;
  projectId: string;
  workspacePath?: string;
  defaultSessionId?: string | null;
  issues?: Issue[];
  onClose: () => void;
  onCreated: (parentId?: string) => void;
  onError: (msg: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>('medium');
  // 父任务用受控 state：组合框支持手输原始 id，也支持点选候选；提交时直接读它。
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
      // v0.4: 创建后唤醒 —— UI 代发 @agent 评论，走现成 watch 链路把编排
      // 请求送达 agent 的 TUI 输入框。评论失败不阻塞创建（best-effort）。
      if (wake) {
        try {
          await api_.addComment(created.id, 'web', `${WAKE_PREFIX} 认领此任务并编排（拆解子任务、排依赖）`);
        } catch (err) {
          onError(`任务已创建，但唤醒失败：${(err as Error).message}`);
        }
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog open className="new-dialog new-issue-dialog">
      <form className="new-issue-form" onSubmit={submit}>
        <div className="dialog-heading">
          <span className="dialog-eyebrow">TASK</span>
          <h2>新建任务</h2>
          <p>任务会自动继承当前项目的 OpenCode Session，执行信息由 Agent 回写。</p>
        </div>
        {workspacePath && <p className="session-hint">工作目录继承自所属项目：{workspacePath}</p>}
        <label>标题<input name="title" required autoFocus placeholder="一句话讲清楚要做什么" /></label>
        <label>父任务（可选，留空为顶层任务）
          <ParentCombobox issues={issues} value={parentId} onChange={id => { setParentId(id); setError(null); }}
            resetSignal={parentReset} placeholder="输入或选择父任务，如 a1b2c3d4" ariaLabel="父任务" />
        </label>
        <div className="session-hint">
          <span>项目默认 Session：</span>
          <code>{defaultSessionId || '尚未配置，请先在项目右键菜单中配置'}</code>
        </div>
        <div className="row">
          <label>优先级
            <Select value={priority} onChange={v => setPriority(v as Priority)}
              options={PRIORITIES.map(p => ({ value: p, label: p }))} />
          </label>
        </div>
        <label>描述<textarea name="description" rows={5} placeholder="背景 / 验收标准 / 注意事项（Markdown）" /></label>
        {/* v0.4: 创建后唤醒 agent（默认勾选）——替代手打 @agent 评论。 */}
        <label className="wake-check"><input type="checkbox" name="wake" defaultChecked /> 创建后唤醒 agent 编排</label>
        {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
        <menu>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={saving || !defaultSessionId}>{saving ? "创建中…" : "创建"}</button>
        </menu>
      </form>
    </dialog>
  );
}
