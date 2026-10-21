import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api_, connectSSE, ApiError, DependencyEdge, GlobalOpenCodeStatus, Progress, Project, Issue, Stats, STATUS_CN, STATUSES, WorkspaceDirectory } from './api';
import { Board, buildBlockedByMap, flattenCardOrder, GroupBy, todayStr } from './components/Board';
import { issueMatchesFilters } from './logic/filters';
import { moveWithRetry, pickMovableChildren } from './logic/groupMove';
import { confirmDialog, promptDialog } from './components/dialogs';
import { Select } from './components/Select';
import { Bell, ChartColumn, GanttChart, Keyboard, Link, Moon, Pencil, Plus, Sun, Trash2, X, Folder, FolderOpen, ChevronDown, ChevronRight, MoreHorizontal, Settings, LogOut, RefreshCw } from 'lucide-react';
import { Drawer } from './components/Drawer';
import { DirectoryPickerDialog } from './components/DirectoryPickerDialog';
import { ProjectSessionDialog } from './components/ProjectSessionDialog';
import { NewIssueDialog } from './components/NewIssueDialog';
import { StatsPanel } from './components/StatsPanel';
import { Timeline } from './components/Timeline';
import { sessionProjectName } from './logic/session';

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

type DirectoryPickerTarget = 'settings' | 'new-directory' | 'directory-edit';
type SortBy = 'priority' | 'created';
type Theme = 'dark' | 'light';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [directories, setDirectories] = useState<WorkspaceDirectory[]>([]);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [directoryCreateOpen, setDirectoryCreateOpen] = useState(false);
  const [directoryName, setDirectoryName] = useState('');
  const [directoryWorkspacePath, setDirectoryWorkspacePath] = useState('');
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [projectSessionProject, setProjectSessionProject] = useState<Project | null>(null);
  const [openCodeStatus, setOpenCodeStatus] = useState<GlobalOpenCodeStatus | null>(null);
  const [directoryStatusLoading, setDirectoryStatusLoading] = useState(false);
  const [directoryStatusError, setDirectoryStatusError] = useState<string | null>(null);
  const [defaultWorkspacePath, setDefaultWorkspacePath] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPathInput, setSettingsPathInput] = useState('');
  const [directoryWorkspaceEditId, setDirectoryWorkspaceEditId] = useState<string | null>(null);
  const [directoryWorkspaceEditPath, setDirectoryWorkspaceEditPath] = useState('');
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPickerTarget, setDirectoryPickerTarget] = useState<DirectoryPickerTarget>('settings');
  const [directoryPickerInitialPath, setDirectoryPickerInitialPath] = useState('');
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
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connError, setConnError] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('created');
  const [filters, setFilters] = useState({ text: '', assignee: '', label: '', due: '' as '' | 'overdue' | 'today' });
  // Remote deployments use first-run admin initialization and a server session cookie.
  const [authScreen, setAuthScreen] = useState<'checking' | 'board' | 'setup' | 'login'>('checking');
  const [authRequired, setAuthRequired] = useState(false);
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [authUsername, setAuthUsername] = useState('admin');
  const [authPassword, setAuthPassword] = useState('');
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
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

  const refreshOpenCodeStatus = useCallback(async (): Promise<void> => {
    setDirectoryStatusLoading(true);
    setDirectoryStatusError(null);
    try { setOpenCodeStatus(await api_.openCodeStatus()); }
    catch (err) { setDirectoryStatusError((err as Error).message); setOpenCodeStatus(null); }
    finally { setDirectoryStatusLoading(false); }
  }, []);

  const refreshAuth = useCallback(async (): Promise<boolean> => {
    try {
      const status = await api_.authStatus();
      setAuthRequired(status.authRequired);
      setCurrentUsername(status.username);
      const ready = !status.authRequired || status.authenticated;
      setAuthScreen(ready ? 'board' : status.initialized ? 'login' : 'setup');
      return ready;
    } catch {
      setCurrentUsername(null);
      setAuthScreen('board');
      setConnError(true);
      return false;
    }
  }, []);

  const showToast = useCallback((msg: string, detail?: string) => {
    setToast({ msg, detail });
    setTimeout(() => setToast(null), 2600);
  }, []);

  const openWorkspaceDirectoryPicker = (target: DirectoryPickerTarget): void => {
    const initialPath = target === 'settings'
      ? settingsPathInput
      : target === 'new-directory'
        ? directoryWorkspacePath || defaultWorkspacePath
        : directoryWorkspaceEditPath;
    setDirectoryPickerTarget(target);
    setDirectoryPickerInitialPath(initialPath);
    setDirectoryPickerOpen(true);
  };

  const handleWorkspaceDirectorySelect = (path: string): void => {
    if (directoryPickerTarget === 'settings') setSettingsPathInput(path);
    else if (directoryPickerTarget === 'new-directory') setDirectoryWorkspacePath(path);
    else setDirectoryWorkspaceEditPath(path);
    setDirectoryPickerOpen(false);
  };

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
    if (!projWorkspacePath.trim()) {
      setProjSessionsLoading(false);
      setProjSessionsError('请先配置项目工作目录，再选择或新建 Session。');
      return;
    }
    setProjSessionsLoading(true);
    setProjSessionsError(null);
    const timer = window.setTimeout(() => {
      api_.openCodeSessionsForDirectory(projectDirectoryId)
        .then(result => {
          if (cancelled) return;
          setProjSessions(result.sessions);
          setProjSessionsError(result.sessions.length ? null : '该工作目录下还没有 Session，请点击右侧按钮创建。');
        })
        .catch(err => { if (!cancelled) setProjSessionsError((err as Error).message); })
        .finally(() => { if (!cancelled) setProjSessionsLoading(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [projCreateOpen, projectDirectoryId, projWorkspacePath]);


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
      if (isUnauthorized(err)) void refreshAuth();
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
      if (isUnauthorized(err)) void refreshAuth();
      else setConnError(true);
    });
  }, []);

  useEffect(() => {
    let active = true;
    // Remove tokens saved by older builds; browser auth is now an HttpOnly cookie.
    localStorage.removeItem('taskboard-token');
    api_.authStatus().then(status => {
      if (!active) return;
      setAuthRequired(status.authRequired);
      setCurrentUsername(status.username);
      const ready = !status.authRequired || status.authenticated;
      setAuthScreen(ready ? 'board' : status.initialized ? 'login' : 'setup');
      if (ready) loadProjects();
    }).catch(() => {
      if (!active) return;
      setCurrentUsername(null);
      setAuthScreen('board');
      setConnError(true);
    });
    return () => { active = false; };
  }, [loadProjects]);

  useEffect(() => {
    if (authScreen !== 'board') return;
    api_.getSettings().then(settings => {
      setDefaultWorkspacePath(settings.defaultWorkspacePath);
      setSettingsPathInput(settings.defaultWorkspacePath);
    }).catch(err => {
      if (isUnauthorized(err)) void refreshAuth();
      else showToast('✗ 读取全局设置失败：' + (err as Error).message);
    });
  }, [showToast, authScreen]);

  useEffect(() => {
    if (!directoryMenuOpen) return;
    const close = (): void => setDirectoryMenuOpen(null);
    // Defer registration so the click that opened the menu does not immediately
    // bubble to document and close it again.
    const timer = window.setTimeout(() => document.addEventListener('click', close), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  }, [directoryMenuOpen]);

  useEffect(() => {
    if (!projectMenu) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setProjectMenu(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [projectMenu]);

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
  useEffect(() => {
    if (authScreen !== 'board') return;
    return connectSSE(() => { setDetailRefreshKey(key => key + 1); void loadProjects(); void refresh(); });
  }, [authScreen, loadProjects, refresh]);
  // T6-31: 面板打开（或切换项目）时立即拉取一次；开着期间的更新走 refresh 内的重取。
  useEffect(() => {
    if (!statsOpen || !projectId) return;
    api_.stats(projectId).then(setStats).catch(err => { if (isUnauthorized(err)) void refreshAuth(); });
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

  if (authScreen === 'checking') {
    return (
      <div className="auth-overlay">
        <div className="auth-card"><span className="glyph">▚</span><h1>taskboard</h1><p>正在检查登录状态…</p></div>
      </div>
    );
  }

  if (authScreen === 'setup' || authScreen === 'login') {
    const isSetup = authScreen === 'setup';
    return (
      <div className="auth-overlay">
        <div className="auth-card">
          <span className="glyph">▚</span>
          <h1>{isSetup ? '初始化 Taskboard' : '登录 Taskboard'}</h1>
          <p>{isSetup ? '首次使用，请创建管理员账号。初始化完成后，公开初始化入口将自动关闭。' : '登录后继续管理任务与 Agent 会话。'}</p>
          <form className="auth-form" onSubmit={async e => {
            e.preventDefault();
            setAuthError('');
            const username = authUsername.trim();
            if (isSetup && authPassword !== authPasswordConfirm) {
              setAuthError('两次输入的密码不一致');
              return;
            }
            setAuthBusy(true);
            try {
              if (isSetup) await api_.initializeAdmin(username, authPassword);
              else await api_.login(username, authPassword);
              setAuthPassword('');
              setAuthPasswordConfirm('');
              const ready = await refreshAuth();
              if (ready) {
                setConnError(false);
                loadProjects();
              }
            } catch (error) {
              setAuthError((error as Error).message || '认证失败，请重试');
            } finally {
              setAuthBusy(false);
            }
          }}>
            <label>管理员账号
              <input autoFocus required minLength={3} maxLength={64} pattern="[A-Za-z0-9._-]+" autoComplete="username"
                value={authUsername} onChange={e => setAuthUsername(e.target.value)} />
            </label>
            <label>密码
              <input type="password" required minLength={isSetup ? 12 : 1} maxLength={256}
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                placeholder={isSetup ? '至少 12 个字符' : '输入管理员密码'}
                value={authPassword} onChange={e => setAuthPassword(e.target.value)} />
            </label>
            {isSetup && <label>确认密码
              <input type="password" required minLength={12} maxLength={256} autoComplete="new-password"
                value={authPasswordConfirm} onChange={e => setAuthPasswordConfirm(e.target.value)} />
            </label>}
            {authError && <p className="auth-error" role="alert">{authError}</p>}
            <button className="btn primary auth-submit" type="submit" disabled={authBusy}>
              {authBusy ? '请稍候…' : isSetup ? '创建管理员并登录' : '登录'}
            </button>
          </form>
          <p className="auth-footnote">无需配置访问 Token。管理员密码仅保存哈希，浏览器通过安全会话 Cookie 保持登录。</p>
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

  const pct = progress && progress.weightedTotal > 0
    ? Math.round((progress.weightedDone / progress.weightedTotal) * 100) : 0;

  return (
    <>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="glyph">▚</span>
            <h1>taskboard</h1>
            {authRequired && <button className="icon-btn auth-logout" title="退出登录" aria-label="退出登录" onClick={async () => {
              try {
                await api_.logout();
                setCurrentUsername(null);
                setAuthPassword('');
                setAuthError('');
                setAuthScreen('login');
              } catch (error) {
                showToast('退出登录失败：' + (error as Error).message);
              }
            }}><LogOut size={14} /></button>}
          </div>
          <button className="side-btn side-create-directory" onClick={() => { setDirectoryName(''); setDirectoryWorkspacePath(defaultWorkspacePath); setDirectoryCreateOpen(true); }}>
            <Plus size={14} /> 新建目录
          </button>
          <div className="sidebar-heading">
            <span>目录</span>
          </div>
          <nav className="side-projects" aria-label="目录与项目">
            {directories.map(directory => {
              const children = projects.filter(project => project.directoryId === directory.id);
              const expanded = expandedDirectories.has(directory.id);
              return (
                <section className="side-directory" key={directory.id}>
                  <div className="side-directory-row" onContextMenu={e => { e.preventDefault(); setDirectoryMenuOpen(directory.id); }}>
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
                      setProjName(''); setProjId(''); setProjLabels('');
                      setProjWorkspacePath(directory.workspacePath || '');
                      setProjInheritLocked(true);
                      setProjectDirectoryId(directory.id); setProjCreateOpen(true);
                      setExpandedDirectories(prev => new Set(prev).add(directory.id));
                    }}><Plus size={14} /></button>
                    <button className="icon-btn" title="目录操作" onClick={() => setDirectoryMenuOpen(prev => prev === directory.id ? null : directory.id)}><MoreHorizontal size={14} /></button>
                    {directoryMenuOpen === directory.id && (
                      <div className="side-directory-menu" role="menu">
                        <button role="menuitem" onClick={async () => {
                          setDirectoryMenuOpen(null);
                          const name = await promptDialog({ title: '重命名目录', lines: ['目录用于在左侧分组管理项目。'], placeholder: '目录名称', value: directory.name });
                          if (name === null) return;
                          try {
                            const updated = await api_.updateDirectory(directory.id, { name: name.trim() });
                            setDirectories(prev => prev.map(item => item.id === updated.id ? updated : item));
                          } catch (err) { showToast('✗ ' + (err as Error).message); }
                        }}><Pencil size={13} /> 重命名目录</button>
                        <button role="menuitem" onClick={() => {
                          setDirectoryMenuOpen(null);
                          setDirectoryWorkspaceEditId(directory.id);
                          setDirectoryWorkspaceEditPath(directory.workspacePath);
                        }}><Folder size={13} /> 修改工作目录</button>
                        <button role="menuitem" className="danger" onClick={async () => {
                          setDirectoryMenuOpen(null);
                          const projectCount = projects.filter(project => project.directoryId === directory.id).length;
                          const ok = await confirmDialog({
                            title: `移除目录「${directoryLabel(directory.name)}」？`,
                            lines: [
                              `目录下的 ${projectCount} 个项目、全部任务与评论、附件将一并删除，不可恢复。`,
                              '其他目录不受影响。'
                            ],
                            confirmText: '移除目录',
                            danger: true
                          });
                          if (!ok) return;
                          try {
                            await api_.deleteDirectory(directory.id, { cascade: true });
                            setDirectories(prev => prev.filter(item => item.id !== directory.id));
                            loadProjects();
                            showToast('已移除目录及其项目');
                          } catch (err) { showToast('✗ ' + (err as Error).message); }
                        }}><Trash2 size={13} /> 移除目录</button>
                      </div>
                    )}
                  </div>
                  <div className="side-directory-meta">{children.length} 个项目</div>
                  {expanded && (
                    <div className="side-directory-projects">
                      {children.map(project => (
                        <button key={project.id} className={`side-item side-project-item${project.id === projectId ? ' active' : ''}`}
                          title={`${project.name}\n${project.workspacePath}\n${project.wakeChannel}`}
                          onContextMenu={e => { e.preventDefault(); setProjectMenu({ id: project.id, x: e.clientX, y: e.clientY }); }}
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
            <button className="icon-btn" title="全局设置" aria-label="全局设置" onClick={() => { setSettingsPathInput(defaultWorkspacePath); setSettingsOpen(true); }}><Settings size={15} /></button>
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
          <p>{directories.length ? '先在左侧目录下创建或选择一个项目。' : '先在左侧新建目录，再在目录下创建项目。'}</p>
          {directories.length > 0 ? (
            <button className="btn primary" onClick={() => {
              const directoryId = directories[0]?.id ?? '';
              setProjectDirectoryId(directoryId);
              setProjName(''); setProjId(''); setProjLabels('');
              setProjWorkspacePath(directories[0]?.workspacePath ?? '');
              setProjDefaultSessionId(''); setProjSessions([]);
              setProjInheritLocked(false);
              setProjCreateOpen(true);
              setExpandedDirectories(prev => new Set(prev).add(directoryId));
            }}>在目录下创建项目</button>
          ) : (
            <button className="btn primary" onClick={() => {
              setDirectoryName('');
              setDirectoryWorkspacePath(defaultWorkspacePath);
              setDirectoryCreateOpen(true);
            }}>＋ 新建目录</button>
          )}
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
        <Drawer issueId={openId} projectId={projectId} refreshKey={detailRefreshKey}
          commentAuthor={currentUsername ?? 'web'}
          onClose={closeDrawer}
          onChanged={() => void refresh()}
          onToast={showToast}
          onOpenIssue={openIssue}
          issues={issues}
          statuses={STATUSES} />
      )}

      <NewIssueDialog open={dialogOpen} projectId={projectId!}
        workspacePath={projects.find(project => project.id === projectId)?.workspacePath}
        defaultSessionId={projects.find(project => project.id === projectId)?.defaultSessionId}
        issues={issues}
        onClose={() => setDialogOpen(false)}
        onCreated={id => { void refresh(); if (id) openIssue(id); }}
        onError={msg => showToast(`✗ ${msg}`)} />

      {directoryCreateOpen && (
        <dialog open className="new-dialog">
          <form onSubmit={async e => {
            e.preventDefault();
            const name = directoryName.trim();
            const workspacePath = directoryWorkspacePath.trim() || defaultWorkspacePath.trim();
            if (!name) { showToast('✗ 目录名称不能为空'); return; }
            if (!workspacePath) { showToast('请先填写当前目录的工作目录，或在全局设置中配置默认工作目录。'); setSettingsPathInput(defaultWorkspacePath); setSettingsOpen(true); return; }
            try {
              const directory = await api_.createDirectory({ name, workspacePath });
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
            <label>默认工作目录地址
              <div className="workspace-path-control">
                <input value={directoryWorkspacePath} placeholder="例如：D:\\workspace\\projects\\my-app" onChange={e => setDirectoryWorkspacePath(e.target.value)} />
                <button type="button" className="btn" onClick={() => openWorkspaceDirectoryPicker('new-directory')}><FolderOpen size={13} /> 选择目录</button>
              </div>
            </label>
            <p className="dialog-note">目录用于统一管理工作目录；项目默认 Session 由项目维护，任务自动继承。OpenCode Server 地址由服务端部署配置统一管理。</p>
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
                defaultWorkspacePath: settingsPathInput.trim()
              });
              setDefaultWorkspacePath(settings.defaultWorkspacePath);
              if (directoryCreateOpen && !directoryWorkspacePath.trim()) setDirectoryWorkspacePath(settings.defaultWorkspacePath);
              setSettingsOpen(false);
              showToast(settings.defaultWorkspacePath ? '已保存全局默认配置' : '已清空全局默认配置');
            } catch (err) { showToast('✗ 保存全局设置失败：' + (err as Error).message); }
          }}>
            <h2>全局设置</h2>
            <label>默认工作目录地址
              <div className="workspace-path-control">
                <input autoFocus value={settingsPathInput} placeholder="例如：D:\\workspace\\projects" onChange={e => setSettingsPathInput(e.target.value)} />
                <button type="button" className="btn" onClick={() => openWorkspaceDirectoryPicker('settings')}><FolderOpen size={13} /> 选择目录</button>
              </div>
            </label>
            <div className="opencode-settings-status">
              <div className="directory-status-heading"><div><span className="dialog-eyebrow">OPENCODE</span><h3>运行状态</h3></div><button type="button" className="btn" disabled={directoryStatusLoading} onClick={() => void refreshOpenCodeStatus()}><RefreshCw size={13} /> 重新检测</button></div>
              {directoryStatusLoading && <p className="session-hint">正在检测 OpenCode 服务…</p>}{directoryStatusError && <p className="form-error">{directoryStatusError}</p>}
              {openCodeStatus && <><div className="directory-status-summary"><span>服务状态</span><strong data-state={openCodeStatus.serverStatus}>{openCodeStatus.serverStatus === 'connected' ? '已连接' : '不可用'}</strong><small>检查于 {new Date(openCodeStatus.checkedAt).toLocaleTimeString()}</small></div>{openCodeStatus.error && <p className="form-error">{openCodeStatus.error}</p>}<div className="directory-status-projects"><div className="directory-status-section-title">项目会话</div>{openCodeStatus.projects.length === 0 && <p className="session-hint">当前没有项目。</p>}{openCodeStatus.projects.map(item => <div className="directory-status-project" key={item.projectId}><div className="directory-status-project-main"><strong>{item.projectName}</strong><span data-state={item.busy ? 'busy' : item.status}>{({busy:'执行中',running:'执行中',retry:'重试中',idle:'空闲','no-session':'未配置 Session',unavailable:'不可用'} as Record<string,string>)[item.status] ?? item.status}</span></div><small>{item.directoryName} · {item.workspacePath || '未配置工作目录'}</small><code title={item.sessionId ?? undefined}>{item.sessionId || '未配置默认 Session'}</code>{item.error && <small className="form-error">{item.error}</small>}</div>)}</div></>}{!openCodeStatus && !directoryStatusLoading && <p className="session-hint">点击「重新检测」查看服务状态。</p>}
            </div>
            <p className="dialog-note">OpenCode Server 地址由服务端部署环境变量统一配置，目录和项目不保存或修改该地址。</p>
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
            if (!projWorkspacePath.trim()) { showToast('✗ 请先在所属目录配置工作目录'); return; }
            if (!projDefaultSessionId) { showToast('✗ 请先选择或新建一个 OpenCode Session'); return; }
            try {
              const project = await api_.createProject({ ...(id ? { id } : {}), name, directoryId: projectDirectoryId, defaultSessionId: projDefaultSessionId, ...(labels ? { labels } : {}) });
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
                <Select value={projectDirectoryId} disabled={projInheritLocked} onChange={value => { const directory = directories.find(d => d.id === value); setProjectDirectoryId(value); setProjWorkspacePath(directory?.workspacePath || ''); setProjDefaultSessionId(''); setProjSessions([]); }}
                  options={directories.map(directory => ({ value: directory.id, label: directory.name }))} placeholder="选择目录" />
              </label>
            </div>
            <div className="directory-config-summary">
              <div><span>工作目录</span><code>{projWorkspacePath || '未配置，请先修改目录设置'}</code></div>
            </div>
            <p className="session-hint">OpenCode Server 地址由服务端部署配置统一管理。</p>
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
                  }}
                    options={projSessions.map(session => ({ value: session.id, label: session.title + ' · ' + session.id.slice(0, 12) }))}
                    placeholder="选择会话"
                    emptyText={projSessionsLoading ? '正在读取 Session…' : '当前没有OpenCode 会话，请先前往OpenCode创建会话'} />
                </div>
                <button type="button" className="btn" disabled={!projectDirectoryId || !projWorkspacePath.trim() || projSessionsLoading}
                  onClick={() => { setSessionTitle(projName.trim() || '新项目'); setSessionCreateOpen(true); }}><Plus size={13} /> 新建 Session</button>
              </div>
            </label>
            {projSessionsError && <p className="form-error">{projSessionsError}</p>}
            <label>标签（可选）<input value={projLabels} placeholder="标签,逗号分隔" onChange={e => setProjLabels(e.target.value)} /></label>
            <p className="dialog-note">工作目录与 Server URL 由目录统一管理；默认 Session 归项目所有，项目下的每个任务自动继承此会话。分支、工作树路径和负责人由 Agent 维护。</p>
            <menu><button type="button" className="btn" onClick={() => { setProjCreateOpen(false); setSessionCreateOpen(false); }}>取消</button><button type="submit" className="btn primary" disabled={projSessionsLoading || !projSessions.some(session => session.id === projDefaultSessionId)}>创建项目</button></menu>
          </form>
        </dialog>
      )}

      {sessionCreateOpen && (
        <dialog open className="new-dialog">
          <form onSubmit={async e => {
            e.preventDefault();
            if (!projectDirectoryId || !projWorkspacePath.trim()) { showToast('✗ 请先选择目录并填写工作目录'); return; }
            const title = sessionTitle.trim();
            if (!title) { showToast('✗ Session 标题不能为空'); return; }
            try {
              const result = await api_.createOpenCodeSession(projectDirectoryId, title);
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
            </div>
            <p className="dialog-note">Session 将在指定的项目工作目录中创建；创建成功后自动选为项目默认 Session。</p>
            <menu><button type="button" className="btn" onClick={() => setSessionCreateOpen(false)}>取消</button><button type="submit" className="btn primary">创建 Session</button></menu>
          </form>
        </dialog>
      )}

      {directoryWorkspaceEditId && (() => {
        const directory = directories.find(item => item.id === directoryWorkspaceEditId);
        if (!directory) return null;
        return (
          <dialog open className="new-dialog">
            <form onSubmit={async e => {
              e.preventDefault();
              const workspacePath = directoryWorkspaceEditPath.trim();
              if (!workspacePath) { showToast('✗ 工作目录地址不能为空'); return; }

              try {
                const routeChanged = workspacePath !== directory.workspacePath;
                const updated = await api_.updateDirectory(directory.id, { workspacePath });
                setDirectories(prev => prev.map(item => item.id === updated.id ? updated : item));
                setDirectoryWorkspaceEditId(null);
                void loadProjects();
                void refresh();
                showToast(routeChanged
                  ? '已更新目录工作目录；所有项目自动继承此路径，项目默认 Session 已清除，请重新配置。'
                  : '目录工作目录未变化。');
              } catch (err) { showToast('✗ ' + (err as Error).message); }
            }}>
              <h2>修改目录工作目录</h2>
              <label>目录
                <input value={directoryLabel(directory.name)} disabled />
              </label>
              <label>工作目录地址
                <div className="workspace-path-control">
                  <input autoFocus required value={directoryWorkspaceEditPath}
                    placeholder="例如：D:\\workspace\\projects\\my-app"
                    onChange={e => setDirectoryWorkspaceEditPath(e.target.value)} />
                  <button type="button" className="btn" onClick={() => openWorkspaceDirectoryPicker('directory-edit')}><FolderOpen size={13} /> 选择目录</button>
                </div>
              </label>
              <p className="dialog-note">这是目录的唯一工作目录配置，目录下所有项目都会继承。工作目录变化后，为避免会话指向旧路径，项目默认 Session 会清除；存在有效 Agent 认领时会拒绝修改。</p>
              <menu>
                <button type="button" className="btn" onClick={() => setDirectoryWorkspaceEditId(null)}>取消</button>
                <button type="submit" className="btn primary">保存路径</button>
              </menu>
            </form>
          </dialog>
        );
      })()}

      <DirectoryPickerDialog
        open={directoryPickerOpen}
        initialPath={directoryPickerInitialPath}
        onClose={() => setDirectoryPickerOpen(false)}
        onSelect={handleWorkspaceDirectorySelect}
      />

      <ProjectSessionDialog
        open={Boolean(projectSessionProject)}
        project={projectSessionProject}
        onClose={() => setProjectSessionProject(null)}
        onSaved={updated => {
          setProjects(prev => prev.map(item => item.id === updated.id ? updated : item));
          setProjectSessionProject(null);
          void refresh();
          showToast('已更新项目默认 Session；项目下的任务将自动继承');
        }}
      />


      {projectMenu && <div className="context-menu-backdrop" onClick={() => setProjectMenu(null)} />}
      {projectMenu && (() => {
        const project = projects.find(item => item.id === projectMenu.id);
        if (!project) return null;
        return (
          <div className="project-context-menu" role="menu" style={{ left: projectMenu.x, top: projectMenu.y }}>
            <button role="menuitem" onClick={async () => {
              setProjectMenu(null);
              const name = await promptDialog({ title: '修改项目名称', lines: ['名称会立即更新到看板与项目列表。'], placeholder: '项目名称', value: project.name });
              if (name === null || !name.trim()) return;
              try {
                const updated = await api_.updateProject(project.id, { name: name.trim() });
                setProjects(prev => prev.map(item => item.id === updated.id ? updated : item));
                showToast('已修改项目名称');
              } catch (err) { showToast('✗ ' + (err as Error).message); }
            }}><Pencil size={13} /> 修改项目名称</button>
            <button role="menuitem" onClick={() => {
              setProjectMenu(null);
              setProjectSessionProject(project);
            }}><Link size={13} /> 配置默认 OpenCode Session</button>
            <button role="menuitem" className="danger" onClick={async () => {
              setProjectMenu(null);
              const ok = await confirmDialog({
                title: `移除项目「${project.name}」？`,
                lines: ['该项目下的全部任务、评论、依赖、活动与附件将一并删除，不可恢复。'],
                confirmText: '移除项目',
                danger: true
              });
              if (!ok) return;
              try {
                await api_.deleteProject(project.id);
                setProjects(prev => prev.filter(item => item.id !== project.id));
                if (projectId === project.id) { closeDrawer(); loadProjects(); }
                showToast('已移除项目');
              } catch (err) { showToast('✗ ' + (err as Error).message); }
            }}><Trash2 size={13} /> 移除项目</button>
          </div>
        );
      })()}

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
