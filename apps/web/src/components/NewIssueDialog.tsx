import { FormEvent, useEffect, useState } from 'react';
import { Select } from './Select';
import { api_, OpenCodeSessionOption, PRIORITIES, Priority } from '../api';
import { WAKE_PREFIX } from '@taskboard/core/types';

export function NewIssueDialog({ open, projectId, onClose, onCreated, onError }: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onCreated: (parentId?: string) => void;
  onError: (msg: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>('medium');
  const [sessions, setSessions] = useState<OpenCodeSessionOption[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSessions([]);
    setSessionId('');
    setSessionsLoading(true);
    setSessionsError(null);
    api_.openCodeSessions(projectId)
      .then(result => {
        if (cancelled) return;
        setSessions(result.sessions);
        if (result.sessions.length === 0) {
          setSessionsError(result.workspacePath
            ? '没有找到目录匹配项目工作区的会话：' + result.workspacePath
            : '当前 OpenCode 服务没有可选会话，请先在 OpenCode 中创建或打开一个会话。');
        }
      })
      .catch(err => {
        if (!cancelled) setSessionsError((err as Error).message);
      })
      .finally(() => { if (!cancelled) setSessionsLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  if (!open) return null;

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const parent = String(f.get('parent') ?? '').trim();
    const wake = f.get('wake') === 'on';
    if (!sessionId) {
      setError('请先选择一个 OpenCode 会话，再创建任务。');
      return;
    }
    setSaving(true);
    try {
      const created = await api_.createIssue(projectId, {
        sessionId,
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
          await api_.addComment(created.id, 'web', `${WAKE_PREFIX} 认领此任务并编排（拆解子任务、排依赖）`);
        } catch (err) {
          onError(`任务已创建，但唤醒失败：${(err as Error).message}`);
        }
      }
      form.reset();
      setPriority('medium');
      setSessionId('');
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
    <dialog open className="new-dialog">
      <form onSubmit={submit}>
        <h2>新任务</h2>
        <label>标题<input name="title" required autoFocus placeholder="一句话讲清楚要做什么" /></label>
        <label>父任务 ID（可选，留空为顶层任务）<input name="parent" placeholder="填父任务 id，如 a1b2c3d4" /></label>
        <label>OpenCode 会话（必选）
          <Select value={sessionId} onChange={value => { setSessionId(value); setError(null); }}
            options={sessions.map(session => ({
              value: session.id,
              label: session.title + ' · ' + session.id.slice(0, 12)
            }))}
            placeholder={sessionsLoading ? '正在读取会话…' : '选择已有会话'} />
        </label>
        {sessionId && sessions.find(session => session.id === sessionId) && (
          <p className="session-hint">
            会话目录：{sessions.find(session => session.id === sessionId)?.directory || '未提供'}
          </p>
        )}
        {sessionsError && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{sessionsError}</p>}
        <div className="row">
          <label>优先级
            <Select value={priority} onChange={v => setPriority(v as Priority)}
              options={PRIORITIES.map(p => ({ value: p, label: p }))} />
          </label>
          <label>分支（可选）<input name="branch" placeholder="如 feat/login" /></label>
        </div>
        <label>描述<textarea name="description" rows={5} placeholder="背景 / 验收标准 / 注意事项（Markdown）" /></label>
        {/* v0.4: 创建后唤醒 agent（默认勾选）——替代手打 @agent 评论。 */}
        <label className="wake-check"><input type="checkbox" name="wake" defaultChecked /> 创建后唤醒 agent 编排</label>
        {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
        <menu>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={saving || sessionsLoading || sessions.length === 0}>{saving ? "创建中…" : "创建"}</button>
        </menu>
      </form>
    </dialog>
  );
}
