import { FormEvent, useEffect, useState } from 'react';
import { Select } from './Select';
import { ParentCombobox } from './ParentCombobox';
import { api_, Issue, OpenCodeSessionOption, PRIORITIES, Priority } from '../api';
import { initialSessionId, mergeSessionOptions } from '../logic/session';
import { WAKE_PREFIX } from '@taskboard/core/types';

export function NewIssueDialog({ open, projectId, workspacePath, serverUrl, defaultSessionId, issues = [], onClose, onCreated, onError }: {
  open: boolean;
  projectId: string;
  workspacePath?: string;
  serverUrl?: string;
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
  const [sessions, setSessions] = useState<OpenCodeSessionOption[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [missingDefault, setMissingDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      // 对话框关闭即丢弃父任务草稿，避免下次打开沿用上一次（取消）的输入。
      setParentId('');
      setParentReset(n => n + 1);
      return;
    }
    let cancelled = false;
    setSessions([]);
    setSessionId(initialSessionId(defaultSessionId));
    setMissingDefault(false);
    setSessionsLoading(true);
    setSessionsError(null);
    api_.openCodeSessions(projectId)
      .then(result => {
        if (cancelled) return;
        setSessions(result.sessions);
        if (defaultSessionId && result.sessions.some(session => session.id === defaultSessionId)) setSessionId(defaultSessionId);
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
  }, [open, projectId, defaultSessionId]);

  if (!open) return null;

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const parent = parentId.trim();
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
          <p>为当前项目创建一个任务，并绑定对应的 OpenCode 会话。</p>
        </div>
        {workspacePath && <p className="session-hint">工作目录继承自所属项目：{workspacePath}</p>}
        <label>标题<input name="title" required autoFocus placeholder="一句话讲清楚要做什么" /></label>
        <label>父任务（可选，留空为顶层任务）
          <ParentCombobox issues={issues} value={parentId} onChange={id => { setParentId(id); setError(null); }}
            resetSignal={parentReset} placeholder="输入或选择父任务，如 a1b2c3d4" ariaLabel="父任务" />
        </label>
        <label>OpenCode 会话（必选）
          <Select value={sessionId} disabled={Boolean(defaultSessionId)} onChange={value => { setSessionId(value); setError(null); }}
            options={sessions.map(session => ({
              value: session.id,
              label: session.title + ' · ' + session.id.slice(0, 12)
            }))}
            placeholder={sessionsLoading ? '正在读取会话…' : '选择已有会话'}
            emptyText={sessionsLoading ? '正在读取会话…' : '当前没有OpenCode 会话，请先前往OpenCode创建会话'} />
        </label>
        {defaultSessionId && (
          <p className="session-hint">
            会话、工作目录{serverUrl ? ` 与 OpenCode Server（${serverUrl}）` : ''} 继承自所属项目，不可修改。
          </p>
        )}
        {sessionId && sessions.find(session => session.id === sessionId) && (
          <p className="session-hint">
            会话目录：{sessions.find(session => session.id === sessionId)?.directory || '未提供'}
          </p>
        )}
        {missingDefault && (
          <p className="session-hint" style={{ color: 'var(--accent)' }}>
            项目默认会话未出现在当前列表中，已保留绑定；请确认该会话仍然有效。
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
