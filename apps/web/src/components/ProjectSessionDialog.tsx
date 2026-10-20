// 已有项目的默认会话配置浮层：复用项目级 opencode-sessions 端点与自定义 Select，
// PATCH sessionId（空串 = 解除绑定）。默认会话不在实时列表时用合成选项兜底。
import { useEffect, useState } from 'react';
import { Project, api_, OpenCodeSessionOption } from '../api';
import { initialSessionId, mergeSessionOptions } from '../logic/session';
import { Select } from './Select';

export function ProjectSessionDialog({ open, project, onClose, onSaved }: {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const projectId = project?.id ?? '';
  const defaultSessionId = project?.defaultSessionId ?? '';
  const [sessions, setSessions] = useState<OpenCodeSessionOption[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [loading, setLoading] = useState(false);
  const [missingDefault, setMissingDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setSessions([]);
    setSessionId(initialSessionId(defaultSessionId));
    setMissingDefault(false);
    setLoading(true);
    setError(null);
    api_.openCodeSessions(projectId)
      .then(result => {
        if (cancelled) return;
        const merged = mergeSessionOptions(result.sessions, defaultSessionId);
        setSessions(merged.options);
        setMissingDefault(merged.missingDefault);
        if (result.sessions.length === 0 && !merged.missingDefault) {
          setError(result.workspacePath
            ? '没有找到目录匹配项目工作区的会话：' + result.workspacePath
            : '当前 OpenCode 服务没有可选会话，请先在 OpenCode 中创建或打开一个会话。');
        }
      })
      .catch(err => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId, defaultSessionId]);

  if (!open || !project) return null;

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api_.updateProject(project.id, { defaultSessionId: sessionId.trim() ? sessionId : null });
      onSaved(updated);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { value: '', label: '不绑定会话（新任务需手动选择）' },
    ...sessions.map(session => ({
      value: session.id,
      label: session.title + ' · ' + session.id.slice(0, 12)
    }))
  ];

  return (
    <dialog open className="new-dialog">
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <h2>配置「{project.name}」的会话</h2>
        <label>OpenCode 会话
          <Select value={sessionId} onChange={value => { setSessionId(value); setError(null); }}
            options={options}
            placeholder={loading ? '正在读取会话…' : '选择默认会话'} />
        </label>
        {loading && <p className="session-hint">正在读取会话…</p>}
        {missingDefault && (
          <p className="session-hint" style={{ color: 'var(--accent)' }}>
            项目默认会话未出现在当前列表中，已保留绑定；请确认该会话仍然有效。
          </p>
        )}
        {error && <p style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</p>}
        <menu>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={saving || loading}>{saving ? '保存中…' : '保存'}</button>
        </menu>
      </form>
    </dialog>
  );
}
