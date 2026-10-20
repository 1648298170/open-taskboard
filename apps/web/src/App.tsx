import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api_, connectSSE, ApiError, DependencyEdge, Progress, Project, Issue, Stats, STATUS_CN, STATUSES, WorkspaceDirectory } from './api';
import { Board, buildBlockedByMap, flattenCardOrder, GroupBy, todayStr } from './components/Board';
import { issueMatchesFilters } from './logic/filters';
import { moveWithRetry, pickMovableChildren } from './logic/groupMove';
import { confirmDialog, promptDialog } from './components/dialogs';
import { Select } from './components/Select';
import { Bell, ChartColumn, GanttChart, Keyboard, Moon, Plus, Sun, Trash2, X, Folder, FolderOpen, ChevronDown, ChevronRight, MoreHorizontal, Settings } from 'lucide-react';
import { Drawer } from './components/Drawer';
import { NewIssueDialog } from './components/NewIssueDialog';
import { StatsPanel } from './components/StatsPanel';
import { Timeline } from './components/Timeline';
import { sessionProjectName, sessionWorkspacePath } from './logic/session';

/** 从 location.hash 解析深链：#/issue/<id> → <id>，其余 → null。 */
function issueIdFromHash(): string | null {
  const m = window.location.hash.match(/^#\/issue\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Legacy projects are migrated into groups named after their old workspace path.
 * Show only the final path segment in the sidebar until the user renames it. */
function directoryLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.includes('/') && !trimmed.includes('\\')) return trimmed;
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || trimmed;
}

type SortBy = 'priority' | 'created';
type Theme = 'dark' | 'light';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [directories, setDirectories] = useState<WorkspaceDirectory[]>([]);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [directoryCreateOpen, setDirectoryCreateOpen] = useState(false);
  const [directoryName, setDirectoryName] = useState('');
  const [directoryWorkspacePath, setDirectoryWorkspacePath] = useState('');
  const [directoryServerUrl, setDirectoryServerUrl] = useState('');
  const [defaultWorkspacePath, setDefaultWorkspacePath] = useState('');
  const [defaultOpenCodeServerUrl, setDefaultOpenCodeServerUrl] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPathInput, setSettingsPathInput] = useState('');
  const [settingsServerInput, setSettingsServerInput] = useState('');
  const [projectDirectoryId, setProjectDirectoryId] = useState('');
  const [projInheritLocked, setProjInheritLocked] = useState(false);
  const [projDefaultSessionId, setProjDefaultSessionId] = useState('');
  const [projSessions, setProjSessions] = useState<import('./api').OpenCodeSessionOption[]>([]);
  const [projSessionsLoading, setProjSessionsLoading] = useState(false);
  const [projSessionsError, setProjSessionsError] = useState<string | null>(null);
  const [sessionCreateOpen, setSessionCreateOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [deps, setDeps] = useState<DependencyEdge[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connError, setConnError] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('created');
  const [filters, setFilters] = useState({ text: '', assignee: '', label: '', due: '' as '' | 'overdue' | 'today' });
  // T2-9: 令牌认证 —— 任一 API 调用 401 时置 true，渲染令牌输入浮层。
  const [needToken, setNeedToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  // toast 支持附一行弱化明细（批量操作列出失败 id）。
  const [toast, setToast] = useState<{ msg: string; detail?: string } | null>(null);
  // T5-26: 批量模式 + 已选 id 集合。
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // T5-27: 泳道分组。
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  // T5-28: 主题（localStorage 持久化，默认暗色）。
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('taskboard-theme') === 'dark' ? 'dark' : 'light');
  // T6-35: 桌面通知开关（存储 '1' 且权限已授予才算开）。
  const [notify, setNotify] = useState(() =>
    localStorage.getItem('taskboard-notify') === '1' && 'Notification' in window && Notification.permission === 'granted');
  // T5-29: j/k 高亮的卡片 id。
  const [cursorId, setCursorId] = useState<string | null>(null);
  // T6-31: 统计面板开关 + 面板数据（打开时拉取，refresh 时重取）。
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  // T7-37: 时间线视图开关（打开时替代看板主体渲染）。
  const [timelineOpen, setTimelineOpen] = useState(false);
  // v0.4: 项目管理（新建对话框浮层；删除走 prompt 输入 id 确认）。
  const [projCreateOpen, setProjCreateOpen] = useState(false);
  const [projName, setProjName] = useState('');
  const [projId, setProjId] = useState('');
  const [projLabels, setProjLabels] = useState('');
  const [projWorkspacePath, setProjWorkspacePath] = useState('');
  const [projServerUrl, setProjServerUrl] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  // v0.4: 旧标签页检测 —— SPA 部署后旧标签页继续跑旧 bundle（多次坑用户的根源）。
  // 周期比对服务器最新 bundle 与当前运行版本，不一致则提示刷新。
  const [staleBundle, setStaleBundle] = useState(false);
  const [bundleHintDismissed, setBundleHintDismissed] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  // T6-35: refresh 回调里读的最新通知开关 + 上次数据签名（ref 防 SSE 闭包过期）。
  const notifyRef = useRef(notify);
  const lastSigRef = useRef<string | null>(null);
  // T6-31: refresh 里读的统计面板开关（同 notifyRef 的防过期手法）。
  const statsOpenRef = useRef(statsOpen);

  const isUnauthorized = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

  const showToast = useCallback((msg: string, detail?: string) => {
    setToast({ msg, detail });
    setTimeout(() => setToast(null), 2600);
  }, []);

  // T5-28: 主题同步到 <html data-theme>；默认（无值/暗色）走 :root 暗色变量。
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { notifyRef.current = notify; }, [notify]);
  useEffect(() => { statsOpenRef.current = statsOpen; }, [statsOpen]);

  useEffect(() => {
    if (!projCreateOpen || !projectDirectoryId) {
      setProjSessions([]);
      setProjDefaultSessionId('');
      setProjSessionsLoading(false);
      setProjSessionsError(null);
      return;
    }
    let cancelled = false;
    setProjSessions([]);
    setProjDefaultSessionId('');
    if (!projWorkspacePath.trim() || !projServerUrl.trim()) {
      setProjSessionsLoading(false);
      setProjSessionsError('请先填写项目工作目录和 OpenCode Server URL，再选择或新建 Session。');
      return;
    }
    setProjSessionsLoading(true);
    setProjSessionsError(null);
    const timer = window.setTimeout(() => {
      api_.openCodeSessionsForDirectory(projectDirectoryId, projWorkspacePath.trim(), projServerUrl.trim())
        .then(result => {
          if (cancelled) return;
          setProjSessions(result.sessions);
          setProjSessionsError(result.sessions.length ? null : '该工作目录下还没有 Session，请点击右侧按钮创建。');
        })
        .catch(err => { if (!cancelled) setProjSessionsError((err as Error).message); })
        .finally(() => { if (!cancelled) setProjSessionsLoading(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [projCreateOpen, projectDirectoryId, projWorkspacePath, projServerUrl]);


  // ---- 深链 #/issue/<id> ----
  // 关闭→打开用 pushState 留一条历史（支持浏览器返回键）；抽屉内切换只 replace，历史不膨胀。
  // pushState/replaceState 不触发 hashchange；hashchange 回调只改 state 不写 hash——无回环。
  const openIssue = useCallback((id: string) => {
    if (openId === null) history.pushState(null, '', `#/issue/${id}`);
    else history.replaceState(null, '', `#/issue/${id}`);
    setOpenId(id);
  }, [openId]);

  const closeDrawer = useCallback(() => {
    setOpenId(null);
    // 清 hash 且不留裸 '#'
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  // 首次加载：若带 #/issue/<id> 直接打开抽屉（数据未加载也没关系，Drawer 按 id 自取）
  useEffect(() => {
    const id = issueIdFromHash();
    if (id) setOpenId(id);
  }, []);

  // 浏览器前进/后退或外部改 hash 时同步抽屉（hash 清空 → 关闭）
  useEffect(() => {
    const onHashChange = (): void => setOpenId(issueIdFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const refresh = useCallback(async (pid = projectId) => {
    if (!pid) return;
    try {
      const [list, prog, edges] = await Promise.all([
        api_.listIssues(pid), api_.progress(pid), api_.listDependencies(pid)
      ]);
      // T6-35: 粗粒度变更检测 —— ids+versions 签名与上次不同且页面隐藏时发桌面通知。
      const sig = list.map(i => `${i.id}@${i.version}`).join(',');
      const prev = lastSigRef.current;
      lastSigRef.current = sig;
      if (prev !== null && prev !== sig && notifyRef.current && document.hidden) {
        try { new Notification('任务看板', { body: '看板有更新' }); } catch { /* 通知失败静默 */ }
      }
      setIssues(list);
      setProgress(prog);
      setDeps(edges);
      // T6-31: 统计面板开着时随本次 refresh 一起重取（失败静默——主列表
      // 的 catch 已处理 401 等公共错误路径）。
      if (statsOpenRef.current) api_.stats(pid).then(setStats).catch(() => {});
    } catch (err) {
      // SSE 回调里的 void refresh() 失败时静默忽略，避免未处理的 Promise 拒绝；
      // 401（令牌缺失/失效）除外 —— 需要弹出令牌输入浮层。
      if (isUnauthorized(err)) setNeedToken(true);
    }
  }, [projectId]);

  const loadProjects = useCallback(() => {
    Promise.all([api_.listProjects(), api_.listDirectories()]).then(([list, directoryList]) => {
      setConnError(false);
      setProjects(list);
      setDirectories(directoryList);
      setExpandedDirectories(prev => {
        const next = new Set(prev);
        if (next.size === 0 && directoryList[0]) next.add(directoryList[0].id);
        return next;
      });
      if (list.length) {
        const prev = localStorage.getItem('project');
        const pid = prev && list.some(p => p.id === prev) ? prev : list[0].id;
        setProjectId(pid);
        const selected = list.find(p => p.id === pid);
        if (selected?.directoryId) setExpandedDirectories(old => new Set(old).add(selected.directoryId!));
      } else setProjectId(null);
    }).catch(err => {
      if (isUnauthorized(err)) setNeedToken(true);
      else setConnError(true);
    });
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    api_.getSettings().then(settings => {
      setDefaultWorkspacePath(settings.defaultWorkspacePath);
      setSettingsPathInput(settings.defaultWorkspacePath);
      setDefaultOpenCodeServerUrl(settings.defaultOpenCodeServerUrl);
      setSettingsServerInput(settings.defaultOpenCodeServerUrl);
    }).catch(err => {
      if (isUnauthorized(err)) setNeedToken(true);
      else showToast('✗ 读取全局设置失败：' + (err as Error).message);
    });
  }, [showToast]);

  // v0.4: bundle 版本检测（挂载时 + 每分钟 + 回到标签页时）
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const html = await (await fetch(location.href, { cache: 'no-store' })).text();
        const latest = (html.match(/assets\/index-[^"]+\.js/) || [])[0]?.split('/').pop();
        const running = [...document.querySelectorAll('script[src]')]
          .map(s => (s as HTMLScriptElement).src.split('/').pop()).find(name => name?.startsWith('index-'));
        if (latest && running) setStaleBundle(running !== latest);
      } catch { /* 离线忽略 */ }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    const onVis = (): void => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  useEffect(() => { if (projectId) { localStorage.setItem('project', projectId); void refresh(projectId); } }, [projectId, refresh]);
  useEffect(() => connectSSE(() => { void loadProjects(); void refresh(); }), [loadProjects, refresh]);
  // T6-31: 面板打开（或切换项目）时立即拉取一次；开着期间的更新走 refresh 内的重取。
  useEffect(() => {
    if (!statsOpen || !projectId) return;
    api_.stats(projectId).then(setStats).catch(err => { if (isUnauthorized(err)) setNeedToken(true); });
  }, [statsOpen, projectId]);

  // ---- 过滤 / 排序 ----
  const filtersActive = filters.text.trim() !== '' || filters.assignee !== '' || filters.label !== '' || filters.due !== '';

  const assigneeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const i of issues) if (i.assignee) s.add(i.assignee);
    return [...s];
  }, [issues]);

  const labelOptions = useMemo(() => {
    const s = new Set<string>();
    for (const i of issues) for (const raw of i.labels.split(',')) {
      const t = raw.trim();
      if (t) s.add(t);
    }
    return [...s];
  }, [issues]);

  // issueId → blocked-by ids（卡片 🔒 徽章的数据源）
  const blockedByMap = useMemo(() => buildBlockedByMap(deps), [deps]);

  const visibleIssues = useMemo(() => {
    // 'priority' 保持 API 顺序（urgent>high>medium>low, createdAt）；'created' 按创建时间倒序
    // ——扁平数组排序后 Board 内父/子分组各自保持该相对顺序。
    const byCreatedDesc = (list: Issue[]): Issue[] =>
      [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (!filtersActive) return sortBy === 'created' ? byCreatedDesc(issues) : issues;
    // due 过滤复用 DuePill 同款纯字符串日期比较（本地时区今天）。
    const today = todayStr();
    const matches = (i: Issue): boolean => issueMatchesFilters(i, filters, today);
    const visible = new Set<string>();
    for (const i of issues) {
      if (!matches(i)) continue;
      visible.add(i.id);
      if (i.parentId) visible.add(i.parentId); // 子命中 → 父可见
    }
    // 父自身命中 → 其全部子任务可见（父仅因子命中而可见时，只显示命中的子任务）
    for (const top of issues) {
      if (top.parentId || !matches(top)) continue;
      for (const c of issues) if (c.parentId === top.id) visible.add(c.id);
    }
    const list = issues.filter(i => visible.has(i.id));
    return sortBy === 'created' ? byCreatedDesc(list) : list;
  }, [issues, filters, filtersActive, sortBy]);

  // T5-29: 可见卡片按渲染顺序的扁平 id 序列（与 Board 泳道/列渲染一致）。
  const flatIds = useMemo(() => flattenCardOrder(visibleIssues, groupBy), [visibleIssues, groupBy]);

  // ---- T5-26: 批量操作 ----
  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitBatch = useCallback(() => {
    setBatchMode(false);
    setSelected(new Set());
  }, []);

  // 逐个执行（乐观锁用全量列表里的当前 version），汇总成功/失败并 toast。
  const runBulk = async (kind: 'done' | 'archive' | 'delete'): Promise<void> => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (kind === 'delete') {
      const ok = await confirmDialog({ title: `删除 ${ids.length} 个任务及其子任务/评论？`, danger: true, confirmText: '删除' });
      if (!ok) return;
    }
    let ok = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        if (kind === 'done') {
          const cur = issues.find(i => i.id === id);
          if (!cur) throw new Error('issue not found');
          await api_.updateIssue(id, { status: 'done', version: cur.version });
        } else if (kind === 'archive') {
          await api_.archiveIssue(id);
        } else {
          await api_.deleteIssue(id);
        }
        ok++;
      } catch {
        failed.push(id);
      }
    }
    setSelected(new Set());
    await refresh();
    showToast(`成功 ${ok} · 失败 ${failed.length}`,
      failed.length ? `失败: ${failed.map(id => `#${id}`).join(' ')}` : undefined);
  };

  // ---- T5-29: 键盘快捷键 ----
  // 输入法组合中不抢键；焦点在表单控件里时除 Escape 外全部跳过。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        // 优先级：帮助 > 对话框 > 抽屉 > 批量选择。输入框里也生效——通用逃生键。
        if (helpOpen) { setHelpOpen(false); return; }
        if (sessionCreateOpen) { setSessionCreateOpen(false); return; }
        if (directoryCreateOpen) { setDirectoryCreateOpen(false); return; }
        if (dialogOpen) { setDialogOpen(false); return; }
        if (projCreateOpen) { setProjCreateOpen(false); setSessionCreateOpen(false); return; }
        if (openId !== null) { closeDrawer(); return; }
        if (batchMode && selected.size > 0) setSelected(new Set());
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === '?') { setHelpOpen(true); return; }
      if (e.key === 'n' && projectId) { setDialogOpen(true); return; }
      if (e.key === 'j' || e.key === 'k') {
        if (flatIds.length === 0) return;
        e.preventDefault();
        const idx = cursorId !== null ? flatIds.indexOf(cursorId) : -1;
        const next = e.key === 'j'
          ? (idx < 0 || idx >= flatIds.length - 1 ? 0 : idx + 1)
          : (idx <= 0 ? flatIds.length - 1 : idx - 1);
        setCursorId(flatIds[next] ?? null);
        return;
      }
      if (e.key === 'Enter' && cursorId !== null && flatIds.includes(cursorId)) {
        e.preventDefault();
        openIssue(cursorId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen, projCreateOpen, directoryCreateOpen, sessionCreateOpen, projectId, openId, batchMode, selected, flatIds, cursorId, closeDrawer, openIssue, helpOpen]);

  // 高亮卡片滚入可视区（j/k 移动可能超出视口）。
  useEffect(() => {
    if (cursorId === null) return;
    document.querySelector(`[data-card-id="${CSS.escape(cursorId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursorId]);

  // ---- T5-28 / T6-35: 头部开关 ----
  const toggleTheme = (): void => {
    setTheme(prev => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('taskboard-theme', next);
      return next;
    });
  };

  const toggleNotify = async (): Promise<void> => {
    if (notify) {
      setNotify(false);
      localStorage.removeItem('taskboard-notify');
      return;
    }
    if (!('Notification' in window)) { showToast('✗ 此浏览器不支持桌面通知'); return; }
    let perm: NotificationPermission = Notification.permission;
    if (perm === 'default') {
      try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; }
    }
    if (perm === 'granted') {
      setNotify(true);
      localStorage.setItem('taskboard-notify', '1');
      showToast('已开启桌面通知');
    } else {
      showToast('✗ 通知权限未授予');
    }
  };

  if (needToken) {
    return (
      <div className="token-overlay">
        <div className="token-card">
          <h2>需要访问令牌</h2>
          <form onSubmit={e => {
            e.preventDefault();
            const t = tokenInput.trim();
            if (!t) return;
            localStorage.setItem('taskboard-token', t);
            setNeedToken(false);
            setTokenInput('');
            setConnError(false);
            loadProjects();   // 重建项目列表（SSE 重连自动带上新令牌）
            void refresh();
          }}>
            <input type="password" autoFocus value={tokenInput} placeholder="TASKBOARD_TOKEN"
              onChange={e => setTokenInput(e.target.value)} />
            <button className="btn primary" type="submit">保存</button>
          </form>
        </div>
      </div>
    );
  }

  if (connError) {
    return (
      <div className="empty-state">
        <p>无法连接 taskboard 服务 — 请先运行 `pnpm start`，或检查 TASKBOARD_URL</p>
        <button className="btn primary" onClick={loadProjects}>重试</button>
      </div>
    );
  }

  if (!projects.length && !directories.length) {
    return (
      <div className="empty-state">
        <p>还没有目录。先创建一个目录，再在目录下创建项目。</p>
        <button className="btn primary" onClick={async () => {
          const name = await promptDialog({ title: '新建目录', lines: ['目录用于在左侧分组管理项目。'], placeholder: '例如：前端项目', value: '' });
          if (name === null) return;
          const workspacePath = await promptDialog({
            title: '设置目录工作目录',
            lines: ['新建项目会默认继承此路径。也可以先在全局设置中配置默认工作目录。'],
            placeholder: '例如：D:\\workspace\\projects',
            value: defaultWorkspacePath
          });
          if (workspacePath === null || !workspacePath.trim()) { showToast('✗ 请填写工作目录后再创建目录'); return; }
          try { await api_.createDirectory({ name: name.trim(), workspacePath: workspacePath.trim() }); loadProjects(); }
          catch (err) { showToast('✗ ' + (err as Error).message); }
        }}>＋ 新建目录</button>
        <button className="btn" onClick={async () => {
          const path = await promptDialog({ title: '全局设置：默认工作目录', lines: ['该路径会预填到以后新建的目录中，不会修改已有目录或项目。'], placeholder: '例如：D:\\workspace\\projects', value: defaultWorkspacePath });
          if (path === null) return;
          try {
            const settings = await api_.updateSettings({ defaultWorkspacePath: path.trim() });
            setDefaultWorkspacePath(settings.defaultWorkspacePath);
            setSettingsPathInput(settings.defaultWorkspacePath);
            showToast('已保存全局默认工作目录');
          } catch (err) { showToast('✗ 保存全局设置失败：' + (err as Error).message); }
        }}>全局设置</button>
        <p className="dialog-note">创建目录后，在左侧目录节点下新建项目，并为项目配置工作目录、OpenCode Server 和 Session。</p>
      </div>
    );
  }

  const pct = progress && progress.weightedTotal > 0
    ? Math.round((progress.weightedDone / progress.weightedTotal) * 100) : 0;

  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="glyph">▚</span>
            <h1>taskboard</h1>
          </div>
          <div className="sidebar-heading">
            <span>目录</span>
            <button className="icon-btn" title="全局设置" aria-label="全局设置" onClick={() => { setSettingsPathInput(defaultWorkspacePath); setSettingsOpen(true); }}><Settings size={15} /></button>
            <button className="icon-btn" title="新建目录" onClick={() => { setDirectoryName(''); setDirectoryWorkspacePath(defaultWorkspacePath); setDirectoryServerUrl(defaultOpenCodeServerUrl); setDirectoryCreateOpen(true); }}><Plus size={15} /></button>
          </div>
          <nav className="side-projects" aria-label="目录与项目">
            {directories.map(directory => {
              const children = projects.filter(project => project.directoryId === directory.id);
              const expanded = expandedDirectories.has(directory.id);
              return (
                <section className="side-directory" key={directory.id}>
                  <div className="side-directory-row">
                    <button className="side-directory-toggle" title={directory.name} onClick={() => setExpandedDirectories(prev => {
                      const next = new Set(prev);
                      if (next.has(directory.id)) next.delete(directory.id); else next.add(directory.id);
                      return next;
                    })}>
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                      <span className="side-directory-name">{directoryLabel(directory.name)}</span>
                    </button>
                    <button className="icon-btn" title="在此目录下新建项目" onClick={() => {
                      const existing = children[0];
                      setProjName(''); setProjId(''); setProjLabels('');
                      setProjWorkspacePath(directory.workspacePath || existing?.workspacePath || '');
                      setProjServerUrl(directory.serverUrl || existing?.wakeChannel || defaultOpenCodeServerUrl);
                      setProjInheritLocked(true);
                      setProjectDirectoryId(directory.id); setProjCreateOpen(true);
                      setExpandedDirectories(prev => new Set(prev).add(directory.id));
                    }}><Plus size={14} /></button>
                    <button className="icon-btn" title="配置目录工作目录" onClick={async () => {
                      const workspacePath = await promptDialog({ title: '配置目录工作目录', lines: ['新建项目时会默认继承此路径；已创建项目的路径不会自动改变。'], placeholder: '例如：D:\\workspace\\projects', value: directory.workspacePath });
                      if (workspacePath === null) return;
                      try {
                        const updated = await api_.updateDirectory(directory.id, { workspacePath: workspacePath.trim() });
                        setDirectories(prev => prev.map(item => item.id === updated.id ? updated : item));
                        showToast('已更新目录工作目录');
                      } catch (err) { showToast('✗ ' + (err as Error).message); }
                    }}><Folder size={14} /></button>
                    <button className="icon-btn" title="重命名目录" onClick={async () => {
                      const name = await promptDialog({ title: '重命名目录', lines: ['目录用于在左侧分组管理项目。'], placeholder: '目录名称', value: directory.name });
                      if (name === null) return;
                      try {
                        const updated = await api_.updateDirectory(directory.id, { name: name.trim() });
                        setDirectories(prev => prev.map(item => item.id === updated.id ? updated : item));
                      } catch (err) { showToast('✗ ' + (err as Error).message); }
                    }}><MoreHorizontal size={14} /></button>
                  </div>
                  <div className="side-directory-meta">{children.length} 个项目</div>
                  {expanded && (
                    <div className="side-directory-projects">
                      {children.map(project => (
                        <button key={project.id} className={`side-item side-project-item${project.id === projectId ? ' active' : ''}`}
                          title={`${project.name}\n${project.workspacePath}\n${project.wakeChannel}`}
                          onClick={() => { setProjectId(project.id); closeDrawer(); }}>
                          <span className="side-name">{project.name}</span>
                          {project.labels && <span className="side-label" title={project.labels}>{project.labels}</span>}
                          <span className="side-project-path">{project.workspacePath || '未配置工作目录'}</span>
                        </button>
                      ))}
                      {!children.length && <div className="side-empty">此目录下还没有项目</div>}
                    </div>
                  )}
                </section>
              );
            })}
            {!directories.length && <div className="side-empty">还没有目录</div>}
          </nav>
          <div className="side-actions">
            <button className="side-btn" onClick={() => { setDirectoryName(''); setDirectoryWorkspacePath(defaultWorkspacePath); setDirectoryServerUrl(defaultOpenCodeServerUrl); setDirectoryCreateOpen(true); }}><Plus size={14} /> 新建目录</button>
            <button className="side-btn" disabled={!directories.length} onClick={() => {
              const current = projects.find(project => project.id === projectId);
              const directoryId = current?.directoryId ?? (directories.some(directory => directory.id === projectDirectoryId) ? projectDirectoryId : directories[0]?.id) ?? '';
              const existing = projects.find(project => project.directoryId === directoryId);
              setProjName(''); setProjId(''); setProjLabels('');
              setProjWorkspacePath(existing?.workspacePath ?? directories.find(d => d.id === directoryId)?.workspacePath ?? '');
              setProjServerUrl(existing?.wakeChannel ?? directories.find(d => d.id === directoryId)?.serverUrl ?? defaultOpenCodeServerUrl);
              setProjInheritLocked(false);
              setProjectDirectoryId(directoryId); setProjCreateOpen(true);
            }}><Plus size={14} /> 新建项目</button>
            <button className="side-btn" disabled={!projectId} onClick={async () => {
              const project = projects.find(p => p.id === projectId);
              if (!project) return;
              const path = await promptDialog({ title: `配置「${project.name}」工作目录`, lines: ['修改后会影响此项目后续的 Session 查询和任务唤醒。'], placeholder: '绝对路径', value: project.workspacePath });
              if (path === null) return;
              const serverUrl = await promptDialog({ title: `配置「${project.name}」OpenCode Server`, lines: ['填写完整地址，例如 http://127.0.0.1:4096。'], placeholder: 'http://127.0.0.1:4096', value: project.wakeChannel });
              if (serverUrl === null) return;
              try {
                const updated = await api_.updateProject(project.id, { workspacePath: path.trim(), wakeChannel: serverUrl.trim(), defaultSessionId: null });
                setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
                showToast('项目配置已更新；为避免误唤醒，原默认 Session 与现有任务的会话绑定已清除，请重新选择会话。');
              } catch (err) { showToast('✗ ' + (err as Error).message); }
            }}>配置当前项目</button>
            <button className="side-btn danger" disabled={!projectId} title="删除当前项目（输入 id 确认）" onClick={async () => {
              const pid = projectId ?? '';
              const pname = projects.find(p => p.id === pid)?.name ?? pid;
              const typed = await promptDialog({ title: `删除项目「${pname}」`, lines: [`项目 id：${pid}`, `${pid} 连同它的全部任务、评论和附件一起删除，不可恢复。`, '输入上面的项目 id 以确认：'], placeholder: pid, value: '' });
              if (typed === null) return;
              if (typed.trim() !== pid) { showToast('✗ 项目 id 不匹配，未删除'); return; }
              try { await api_.deleteProject(pid); showToast(`已删除项目 ${pid}`); loadProjects(); }
              catch (err) { showToast(`✗ ${(err as Error).message}`); }
            }}><Trash2 size={14} /> 删除当前项目</button>
          </div>
        </aside>
        <div className="main-col">
          <header className="topbar">
            <div className="topbar-context">
              <strong>{projects.find(project => project.id === projectId)?.name ?? '选择项目'}</strong>
              <span>{projects.find(project => project.id === projectId)?.workspacePath ?? '从左侧选择一个项目开始工作'}</span>
            </div>
            <div className="controls">
              <div className="progress" title="weighted: 父任务等权统计">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
                <span className="progress-label">
                  {progress ? `${progress.weightedDone}/${progress.weightedTotal} · ${pct}%` : '–'}
                </span>
              </div>
              <button className="btn primary" disabled={!projectId} onClick={() => setDialogOpen(true)}>
                <Plus size={14} /> 新任务</button>
              {/* T5-28 主题切换：图标显示将切换到的目标主题。 */}
              <button className="icon-btn" aria-label="切换主题" title="切换主题"
                onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
              {/* T6-35 桌面通知开关：仅看板隐藏时的后台变更提醒。 */}
              <button className={`icon-btn${notify ? ' on' : ''}`} aria-label="桌面通知" title="桌面通知"
                onClick={() => void toggleNotify()}><Bell size={16} /></button>
              {/* T6-31 统计面板开关。 */}
              <button className={`icon-btn${statsOpen ? ' on' : ''}`} aria-label="统计" title="统计面板"
                onClick={() => setStatsOpen(o => !o)}><ChartColumn size={16} /></button>
              {/* T7-37 时间线视图开关（激活时替代看板主体）。 */}
              <button className={`icon-btn${timelineOpen ? ' on' : ''}`} aria-label="时间线" title="时间线视图（甘特 lite）"
                onClick={() => setTimelineOpen(o => !o)}><GanttChart size={16} /></button>
              {/* v0.4: 快捷键帮助（? 键同效）。 */}
              <button className={`icon-btn${helpOpen ? ' on' : ''}`} aria-label="快捷键帮助" title="快捷键帮助（?）"
                onClick={() => setHelpOpen(o => !o)}><Keyboard size={16} /></button>
            </div>
          </header>

      <section className="workspace-toolbar" aria-label="任务工作区">
        <div className="workspace-toolbar-heading">
          <div>
            <h2>任务</h2>
            <p>管理当前项目的任务、进度与优先级</p>
          </div>
          <span className="workspace-task-count">{visibleIssues.length} 项任务</span>
        </div>
      <div className="toolbar">
        <input ref={searchInputRef} className="toolbar-search" placeholder="搜索标题/描述…" value={filters.text}
          onChange={e => setFilters(f => ({ ...f, text: e.target.value }))} />
        <Select title="按负责人过滤" value={filters.assignee} onChange={v => setFilters(f => ({ ...f, assignee: v }))}
          options={[{ value: '', label: '全部' }, ...assigneeOptions.map(a => ({ value: a, label: a }))]} />
        <Select title="按标签过滤" value={filters.label} onChange={v => setFilters(f => ({ ...f, label: v }))}
          options={[{ value: '', label: '全部' }, ...labelOptions.map(l => ({ value: l, label: l }))]} />
        {/* v0.4: 逾期 / 今日截止 chip —— 与文本/负责人/标签过滤天然可叠加。 */}
        <button type="button" title="截止日期已过且未完成"
          className={`btn tiny${filters.due === 'overdue' ? ' active' : ''}`}
          onClick={() => setFilters(f => ({ ...f, due: f.due === 'overdue' ? '' : 'overdue' }))}>逾期</button>
        <button type="button" title="截止日期是今天"
          className={`btn tiny${filters.due === 'today' ? ' active' : ''}`}
          onClick={() => setFilters(f => ({ ...f, due: f.due === 'today' ? '' : 'today' }))}>今日截止</button>
        {/* T5-27: 泳道分组维度。 */}
        <Select title="分组" value={groupBy} onChange={v => setGroupBy(v as GroupBy)}
          options={[{ value: 'none', label: '无' }, { value: 'assignee', label: '按负责人' }, { value: 'label', label: '按标签' }]} />
        {/* T5-26: 批量模式开关。 */}
        <button type="button" className={`btn tiny${batchMode ? ' active' : ''}`}
          onClick={() => { setBatchMode(b => !b); setSelected(new Set()); }}>批量模式</button>
        <div className="sort-toggle">
          <button type="button" className={sortBy === 'created' ? 'active' : ''}
            onClick={() => setSortBy('created')}>按创建时间</button>
          <button type="button" className={sortBy === 'priority' ? 'active' : ''}
            onClick={() => setSortBy('priority')}>按优先级</button>
        </div>
      </div>
      </section>

      {/* T6-31: 统计面板 —— toolbar 与看板之间的一个区段。 */}
      {statsOpen && <StatsPanel stats={stats} />}

      {/* T5-26: 批量操作条。 */}
      {batchMode && (
        <div className="bulk-bar">
          <span className="bulk-count">已选 {selected.size}</span>
          <button className="btn tiny" disabled={selected.size === 0} onClick={() => void runBulk('done')}>批量完成</button>
          <button className="btn tiny" disabled={selected.size === 0} onClick={() => void runBulk('archive')}>批量归档</button>
          <button className="btn tiny" disabled={selected.size === 0} style={{ color: 'var(--danger)' }}
            onClick={() => void runBulk('delete')}>批量删除</button>
          <button className="btn tiny" onClick={exitBatch}>取消</button>
        </div>
      )}

      {/* T7-37: 时间线激活时替代看板主体（纯前端视图，数据同 visibleIssues，
          过滤/排序工具栏照常生效）。 */}
      {!projectId ? (
        <div className="empty-state project-empty-state">
          <p>先在左侧目录下创建或选择一个项目。</p>
          <button className="btn primary" disabled={!directories.length} onClick={() => {
            const directoryId = directories[0]?.id ?? '';
            setProjectDirectoryId(directoryId);
            setProjName(''); setProjId(''); setProjLabels('');
            setProjWorkspacePath(directories[0]?.workspacePath ?? '');
            setProjServerUrl(directories[0]?.serverUrl || defaultOpenCodeServerUrl);
            setProjDefaultSessionId(''); setProjSessions([]);
            setProjInheritLocked(false);
            setProjCreateOpen(true);
            setExpandedDirectories(prev => new Set(prev).add(directoryId));
          }}>在目录下创建项目</button>
        </div>
      ) : timelineOpen
        ? <Timeline issues={visibleIssues} onOpen={openIssue} />
        : <Board issues={visibleIssues} onOpen={openIssue} blockedByMap={blockedByMap} onDrop={async (id, status) => {
          const issue = issues.find(i => i.id === id);
          if (!issue || issue.status === status) return;
          // 🔒 守卫：被未完成任务阻塞的卡片不允许拖列（服务端无状态机约束，
          // 这是唯一的流转防线）。
          const unmet = (blockedByMap.get(id) ?? [])
            .filter(dep => issues.find(i => i.id === dep)?.status !== 'done');
          if (unmet.length > 0) {
            showToast(`✗ #${id} 被未完成任务阻塞：${unmet.map(d => `#${d}`).join(' ')}`);
            return;
          }
          // v0.4: 拖父任务 = 整组移动。嵌套渲染下子卡随父卡走，所见即所动
          // ——静默跟随是正确语义。唯一例外：拖到 done（验收逐任务成立，
          // 列出清单人工确认后才级联）。
          const kids = issue.parentId ? [] : pickMovableChildren(issues, issue.id, status);
          let moveKids = kids.length > 0;
          if (moveKids && status === 'done') {
            moveKids = await confirmDialog({
              title: `同时将 ${kids.length} 个子任务置为 done？`,
              lines: kids.map(k => `#${k.id} ${k.title} [${STATUS_CN[k.status] ?? k.status}]`),
              confirmText: '整组验收',
              cancelText: '仅父任务置 done'
            });
          }
          const move = (issueId: string, curVersion: number): Promise<void> =>
            moveWithRetry({ updateIssue: api_.updateIssue, showIssue: api_.showIssue }, issueId, status, curVersion);
          try {
            if (moveKids) {
              for (const k of kids) {
                try {
                  await move(k.id, k.version);
                } catch (err) { showToast(`✗ 子任务 #${k.id}：${(err as Error).message}`); }
              }
            }
            await move(id, issue.version);
            showToast(`#${id} → ${status}${moveKids ? `（含 ${kids.length} 个子任务）` : ''}`);
            await refresh();
          } catch (err) { showToast(`✗ ${(err as Error).message}`); void refresh(); }
        }} emptyHint={filtersActive ? '无匹配任务' : undefined}
          groupBy={groupBy}
          batchMode={batchMode}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          cursorId={cursorId} />}
        </div>
      </div>

      {openId && (
        <Drawer issueId={openId} projectId={projectId} onClose={closeDrawer}
          onChanged={() => void refresh()}
          onToast={showToast}
          onOpenIssue={openIssue}
          issues={issues}
          statuses={STATUSES} />
      )}

      <NewIssueDialog open={dialogOpen} projectId={projectId!}
        workspacePath={projects.find(project => project.id === projectId)?.workspacePath}
        serverUrl={projects.find(project => project.id === projectId)?.wakeChannel}
        defaultSessionId={projects.find(project => project.id === projectId)?.defaultSessionId}
        onClose={() => setDialogOpen(false)}
        onCreated={id => { void refresh(); if (id) openIssue(id); }}
        onError={msg => showToast(`✗ ${msg}`)} />

      {directoryCreateOpen && (
        <dialog open className="new-dialog">
          <form onSubmit={async e => {
            e.preventDefault();
            const name = directoryName.trim();
            const workspacePath = directoryWorkspacePath.trim() || defaultWorkspacePath.trim();
            const serverUrl = directoryServerUrl.trim() || defaultOpenCodeServerUrl.trim();
            if (!name) { showToast('✗ 目录名称不能为空'); return; }
            if (!workspacePath) { showToast('请先填写当前目录的工作目录，或在全局设置中配置默认工作目录。'); setSettingsPathInput(defaultWorkspacePath); setSettingsOpen(true); return; }
            if (!serverUrl) { showToast('请先填写当前目录的 OpenCode Server URL，或在全局设置中配置默认 Server URL。'); setSettingsServerInput(defaultOpenCodeServerUrl); setSettingsOpen(true); return; }
            try {
              const directory = await api_.createDirectory({ name, workspacePath, serverUrl });
              setDirectories(prev => [...prev, directory]);
              setExpandedDirectories(prev => new Set(prev).add(directory.id));
              setDirectoryCreateOpen(false);
              setProjectDirectoryId(directory.id);
              setProjWorkspacePath(directory.workspacePath);
              showToast('已创建目录：' + directory.name);
            } catch (err) { showToast('✗ ' + (err as Error).message); }
          }}>
            <h2>新建目录</h2>
            <label>目录名称<input required autoFocus value={directoryName} placeholder="例如：前端项目" onChange={e => setDirectoryName(e.target.value)} /></label>
            <label>默认工作目录地址<input value={directoryWorkspacePath} placeholder="例如：D:\\workspace\\projects\\my-app" onChange={e => setDirectoryWorkspacePath(e.target.value)} /></label>
            <label>OpenCode Server URL<input value={directoryServerUrl} placeholder="例如：http://127.0.0.1:4096" onChange={e => setDirectoryServerUrl(e.target.value)} /></label>
            <p className="dialog-note">新建项目时会自动继承此工作目录与 OpenCode Server URL，且项目内不可修改；Session 在项目中绑定。全局设置可提供默认值。</p>
            <menu><button type="button" className="btn" onClick={() => setDirectoryCreateOpen(false)}>取消</button><button type="submit" className="btn primary">创建目录</button></menu>
          </form>
        </dialog>
      )}

      {settingsOpen && (
        <dialog open className="new-dialog">
          <form onSubmit={async e => {
            e.preventDefault();
            try {
              const settings = await api_.updateSettings({
                defaultWorkspacePath: settingsPathInput.trim(),
                defaultOpenCodeServerUrl: settingsServerInput.trim()
              });
              setDefaultWorkspacePath(settings.defaultWorkspacePath);
              setDefaultOpenCodeServerUrl(settings.defaultOpenCodeServerUrl);
              if (directoryCreateOpen && !directoryWorkspacePath.trim()) setDirectoryWorkspacePath(settings.defaultWorkspacePath);
              if (directoryCreateOpen && !directoryServerUrl.trim()) setDirectoryServerUrl(settings.defaultOpenCodeServerUrl);
              setSettingsOpen(false);
              showToast(settings.defaultWorkspacePath || settings.defaultOpenCodeServerUrl ? '已保存全局默认配置' : '已清空全局默认配置');
            } catch (err) { showToast('✗ 保存全局设置失败：' + (err as Error).message); }
          }}>
            <h2>全局设置</h2>
            <label>默认工作目录地址
              <input autoFocus value={settingsPathInput} placeholder="例如：D:\\workspace\\projects" onChange={e => setSettingsPathInput(e.target.value)} />
            </label>
            <label>默认 OpenCode Server URL
              <input value={settingsServerInput} placeholder="例如：http://127.0.0.1:4096" onChange={e => setSettingsServerInput(e.target.value)} />
            </label>
            <p className="dialog-note">新建目录时会默认填入这两个值；目录创建后，其工作目录与 Server URL 会锁定到项目。修改此设置不会自动修改已创建的目录和项目。</p>
            <menu><button type="button" className="btn" onClick={() => setSettingsOpen(false)}>取消</button><button type="submit" className="btn primary">保存设置</button></menu>
          </form>
        </dialog>
      )}

      {projCreateOpen && (
        <dialog open className="new-dialog">
          <form onSubmit={async e => {
            e.preventDefault();
            const name = projName.trim();
            const id = projId.trim();
            const labels = projLabels.trim();
            if (!name) { showToast('✗ 项目名称不能为空'); return; }
            if (!projectDirectoryId || !directories.some(directory => directory.id === projectDirectoryId)) { showToast('✗ 请先选择目录'); return; }
            if (!projWorkspacePath.trim() || !projServerUrl.trim()) { showToast('✗ 请填写项目工作目录和 OpenCode Server URL'); return; }
            if (!projDefaultSessionId) { showToast('✗ 请先选择或新建一个 OpenCode Session'); return; }
            try {
              const project = await api_.createProject({ ...(id ? { id } : {}), name, directoryId: projectDirectoryId, defaultSessionId: projDefaultSessionId, workspacePath: projWorkspacePath.trim(), wakeChannel: projServerUrl.trim(), ...(labels ? { labels } : {}) });
              setProjCreateOpen(false);
              setProjects(prev => [...prev, project]);
              setProjectId(project.id);
              setExpandedDirectories(prev => new Set(prev).add(projectDirectoryId));
              showToast('已创建项目 ' + project.name);
              void refresh(project.id);
            } catch (err) { showToast('✗ ' + (err as Error).message); }
          }}>
            <h2>新建项目</h2>
            <label>项目名称<input required autoFocus value={projName} placeholder="例如：登录模块" onChange={e => setProjName(e.target.value)} /></label>
            <div className="row">
              <label>项目 ID（可选）<input value={projId} placeholder="留空自动生成" onChange={e => setProjId(e.target.value)} /></label>
              <label>目录
                <Select value={projectDirectoryId} disabled={projInheritLocked} onChange={value => { const existing = projects.find(project => project.directoryId === value); const directory = directories.find(d => d.id === value); setProjectDirectoryId(value); setProjWorkspacePath(directory?.workspacePath || existing?.workspacePath || ''); setProjServerUrl(existing?.wakeChannel || directory?.serverUrl || defaultOpenCodeServerUrl); setProjDefaultSessionId(''); setProjSessions([]); }}
                  options={directories.map(directory => ({ value: directory.id, label: directory.name }))} placeholder="选择目录" />
              </label>
            </div>
            <label>项目工作目录绝对路径
              <input required disabled={projInheritLocked} value={projWorkspacePath} placeholder="例如：D:\\workspace\\projects\\my-app"
                onChange={e => { setProjWorkspacePath(e.target.value); setProjDefaultSessionId(''); }} />
            </label>
            <label>OpenCode Server URL
              <input required disabled={projInheritLocked} value={projServerUrl} placeholder="例如：http://127.0.0.1:4096"
                onChange={e => { setProjServerUrl(e.target.value); setProjDefaultSessionId(''); }} />
            </label>
            {projInheritLocked && <p className="session-hint">工作目录与 OpenCode Server URL 继承自目录，不可修改。</p>}
            <label>默认 OpenCode Session（必选）
              <div className="session-select-row">
                <div className="session-select-control">
                  <Select value={projDefaultSessionId} onChange={value => {
                    setProjDefaultSessionId(value);
                    const picked = projSessions.find(session => session.id === value);
                    // Selecting a Session fills the project name and workspace;
                    // both stay editable so advanced setups can still override.
                    const pickedName = sessionProjectName(picked);
                    if (pickedName) setProjName(pickedName);
                    const pickedWorkspace = sessionWorkspacePath(picked);
                    if (!projInheritLocked && pickedWorkspace) setProjWorkspacePath(pickedWorkspace);
                  }}
                    options={projSessions.map(session => ({ value: session.id, label: session.title + ' · ' + session.id.slice(0, 12) }))}
                    placeholder="选择会话"
                    emptyText={projSessionsLoading ? '正在读取 Session…' : '当前没有OpenCode 会话，请先前往OpenCode创建会话'} />
                </div>
                <button type="button" className="btn" disabled={!projectDirectoryId || !projWorkspacePath.trim() || !projServerUrl.trim() || projSessionsLoading}
                  onClick={() => { setSessionTitle(projName.trim() || '新项目'); setSessionCreateOpen(true); }}><Plus size={13} /> 新建 Session</button>
              </div>
            </label>
            {projSessionsError && <p className="form-error">{projSessionsError}</p>}
            <label>标签（可选）<input value={projLabels} placeholder="标签,逗号分隔" onChange={e => setProjLabels(e.target.value)} /></label>
            <p className="dialog-note">目录工作目录仅是默认值；项目实际工作目录、OpenCode Server 和默认 Session 必须配置。服务端会校验 Session 的实际目录。新建任务自动继承项目的工作目录和默认 Session。</p>
            <menu><button type="button" className="btn" onClick={() => { setProjCreateOpen(false); setSessionCreateOpen(false); }}>取消</button><button type="submit" className="btn primary" disabled={projSessionsLoading || !projSessions.some(session => session.id === projDefaultSessionId)}>创建项目</button></menu>
          </form>
        </dialog>
      )}

      {sessionCreateOpen && (
        <dialog open className="new-dialog">
          <form onSubmit={async e => {
            e.preventDefault();
            if (!projectDirectoryId || !projWorkspacePath.trim() || !projServerUrl.trim()) { showToast('✗ 请先选择目录并填写工作目录和 Server URL'); return; }
            const title = sessionTitle.trim();
            if (!title) { showToast('✗ Session 标题不能为空'); return; }
            try {
              const result = await api_.createOpenCodeSession(projectDirectoryId, title, projWorkspacePath.trim(), projServerUrl.trim());
              setProjSessions(prev => [result.session, ...prev.filter(session => session.id !== result.session.id)]);
              setProjDefaultSessionId(result.session.id);
              setProjSessionsError(null);
              setSessionCreateOpen(false);
              showToast('已创建并选中 Session：' + result.session.id);
            } catch (err) { showToast('✗ ' + (err as Error).message); }
          }}>
            <h2>新建 OpenCode Session</h2>
            <label>Session 标题<input required autoFocus value={sessionTitle} onChange={e => setSessionTitle(e.target.value)} placeholder="例如：登录模块开发" /></label>
            <div className="directory-config-summary">
              <div><span>目录分组</span><code>{directories.find(directory => directory.id === projectDirectoryId)?.name ?? ''}</code></div>
              <div><span>工作目录</span><code>{projWorkspacePath}</code></div>
              <div><span>Server</span><code>{projServerUrl}</code></div>
            </div>
            <p className="dialog-note">Session 将在指定的项目工作目录中创建；创建成功后自动选为项目默认 Session。</p>
            <menu><button type="button" className="btn" onClick={() => setSessionCreateOpen(false)}>取消</button><button type="submit" className="btn primary">创建 Session</button></menu>
          </form>
        </dialog>
      )}

      {/* v0.4: 快捷键帮助浮层（? 呼出，Esc / 点击遮罩关闭）。 */}
      {helpOpen && (
        <div className="token-overlay" onClick={() => setHelpOpen(false)}>
          <div className="token-card help-card" onClick={e => e.stopPropagation()}>
            <h2>快捷键</h2>
            <ul className="help-list">
              <li><kbd>/</kbd> 聚焦搜索</li>
              <li><kbd>n</kbd> 新建任务</li>
              <li><kbd>j</kbd>/<kbd>k</kbd> 下 / 上移动光标</li>
              <li><kbd>Enter</kbd> 打开光标卡片</li>
              <li><kbd>Esc</kbd> 关闭浮层 / 抽屉 / 清空批量选择</li>
              <li><kbd>?</kbd> 本帮助</li>
            </ul>
            <p className="help-note">批量模式、泳道分组、逾期过滤在工具栏切换。</p>
          </div>
        </div>
      )}

      {/* v0.4: 新版本提示条（旧标签页检测） */}
      {staleBundle && !bundleHintDismissed && (
        <div className="update-banner">
          <span>🚀 面板有新版本（当前页面可能缺少新功能/修复）</span>
          <button className="btn tiny primary" onClick={() => location.reload()}>立即刷新</button>
          <button className="icon-btn" aria-label="关闭提示" onClick={() => setBundleHintDismissed(true)}><X size={14} /></button>
        </div>
      )}

      {toast && (
        <div className="toast">
          <div>{toast.msg}</div>
          {toast.detail && <div className="toast-detail">{toast.detail}</div>}
        </div>
      )}
    </>
  );
}
