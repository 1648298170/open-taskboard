import { useCallback, useEffect, useState } from 'react';
import { api_, connectSSE, Progress, Project, Issue, STATUSES } from './api';
import { Board } from './components/Board';
import { Drawer } from './components/Drawer';
import { NewIssueDialog } from './components/NewIssueDialog';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [connError, setConnError] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const refresh = useCallback(async (pid = projectId) => {
    if (!pid) return;
    try {
      const [list, prog] = await Promise.all([api_.listIssues(pid), api_.progress(pid)]);
      setIssues(list);
      setProgress(prog);
    } catch {
      // SSE 回调里的 void refresh() 失败时静默忽略，避免未处理的 Promise 拒绝
    }
  }, [projectId]);

  const loadProjects = useCallback(() => {
    api_.listProjects().then(list => {
      setConnError(false);
      setProjects(list);
      if (list.length) {
        const prev = localStorage.getItem('project');
        const pid = prev && list.some(p => p.id === prev) ? prev : list[0].id;
        setProjectId(pid);
      }
    }).catch(() => setConnError(true));
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => { if (projectId) { localStorage.setItem('project', projectId); void refresh(projectId); } }, [projectId, refresh]);
  useEffect(() => connectSSE(() => void refresh()), [refresh]);

  if (connError) {
    return (
      <div className="empty-state">
        <p>无法连接 taskboard 服务 — 请先运行 `pnpm start`，或检查 TASKBOARD_URL</p>
        <button className="btn primary" onClick={loadProjects}>重试</button>
      </div>
    );
  }

  if (!projects.length) {
    return (
      <div className="empty-state">
        <p>还没有项目。<a href="#" onClick={async e => {
          e.preventDefault();
          try {
            const p = await api_.createProject({ id: 'demo', name: 'Demo 项目' });
            const parent = await api_.createIssue(p.id, { title: '搭建登录模块', priority: 'high', branch: 'feat/login', description: '示例父任务，包含可拆解的子任务。' });
            for (const [title, priority] of [['登录表单 UI', 'medium'], ['JWT 鉴权接口', 'high'], ['会话刷新逻辑', 'medium']] as const) {
              await api_.createIssue(p.id, { parentId: parent.id, title, priority });
            }
            setProjects([p]); setProjectId(p.id);
          } catch (err) { showToast(`✗ ${(err as Error).message}`); }
        }}>一键创建示例项目</a></p>
        <pre>taskboard project create --id my-project --name "My project"
taskboard issue create --project my-project --title "第一个任务"</pre>
      </div>
    );
  }

  const pct = progress && progress.weightedTotal > 0
    ? Math.round((progress.weightedDone / progress.weightedTotal) * 100) : 0;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="glyph">▚</span>
          <h1>taskboard</h1>
        </div>
        <div className="controls">
          <label className="field">
            <span>project</span>
            <select value={projectId ?? ''} onChange={e => { setProjectId(e.target.value); setOpenId(null); }}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
          </label>
          <div className="progress" title="weighted: 父任务等权统计">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
            <span className="progress-label">
              {progress ? `${progress.weightedDone}/${progress.weightedTotal} · ${pct}%` : '–'}
            </span>
          </div>
          <button className="btn primary" onClick={() => setDialogOpen(true)}>＋ 新任务</button>
        </div>
      </header>

      <Board issues={issues} onOpen={setOpenId} onDrop={async (id, status) => {
        const issue = issues.find(i => i.id === id);
        if (!issue || issue.status === status) return;
        try {
          await api_.updateIssue(id, { status, version: issue.version });
          showToast(`#${id} → ${status}`);
          await refresh();
        } catch (err) { showToast(`✗ ${(err as Error).message}`); void refresh(); }
      }} />

      {openId && (
        <Drawer issueId={openId} onClose={() => setOpenId(null)}
          onChanged={() => void refresh()}
          onToast={showToast}
          onOpenIssue={setOpenId}
          statuses={STATUSES} />
      )}

      <NewIssueDialog open={dialogOpen} projectId={projectId!}
        onClose={() => setDialogOpen(false)}
        onCreated={id => { void refresh(); if (id) setOpenId(id); }}
        onError={msg => showToast(`✗ ${msg}`)} />

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
