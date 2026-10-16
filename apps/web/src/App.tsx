import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api_, connectSSE, ApiError, DependencyEdge, Progress, Project, Issue, Stats, STATUSES } from './api';
import { Board, buildBlockedByMap, flattenCardOrder, GroupBy } from './components/Board';
import { Drawer } from './components/Drawer';
import { NewIssueDialog } from './components/NewIssueDialog';
import { StatsPanel } from './components/StatsPanel';
import { Timeline } from './components/Timeline';

/** 从 location.hash 解析深链：#/issue/<id> → <id>，其余 → null。 */
function issueIdFromHash(): string | null {
  const m = window.location.hash.match(/^#\/issue\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

type SortBy = 'priority' | 'created';
type Theme = 'dark' | 'light';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [deps, setDeps] = useState<DependencyEdge[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connError, setConnError] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('priority');
  const [filters, setFilters] = useState({ text: '', assignee: '', label: '' });
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
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('taskboard-theme') === 'light' ? 'light' : 'dark');
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
    api_.listProjects().then(list => {
      setConnError(false);
      setProjects(list);
      if (list.length) {
        const prev = localStorage.getItem('project');
        const pid = prev && list.some(p => p.id === prev) ? prev : list[0].id;
        setProjectId(pid);
      }
    }).catch(err => {
      if (isUnauthorized(err)) setNeedToken(true);
      else setConnError(true);
    });
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => { if (projectId) { localStorage.setItem('project', projectId); void refresh(projectId); } }, [projectId, refresh]);
  useEffect(() => connectSSE(() => void refresh()), [refresh]);
  // T6-31: 面板打开（或切换项目）时立即拉取一次；开着期间的更新走 refresh 内的重取。
  useEffect(() => {
    if (!statsOpen || !projectId) return;
    api_.stats(projectId).then(setStats).catch(err => { if (isUnauthorized(err)) setNeedToken(true); });
  }, [statsOpen, projectId]);

  // ---- 过滤 / 排序 ----
  const filtersActive = filters.text.trim() !== '' || filters.assignee !== '' || filters.label !== '';

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
    const q = filters.text.trim().toLowerCase();
    const matches = (i: Issue): boolean =>
      (!q || i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      && (!filters.assignee || i.assignee === filters.assignee)
      && (!filters.label || i.labels.split(',').map(s => s.trim()).includes(filters.label));
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
    if (kind === 'delete' && !window.confirm(`确认删除 ${ids.length} 个任务及其子任务/评论？`)) return;
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
        // 优先级：对话框 > 抽屉 > 批量选择。输入框里也生效——通用逃生键。
        if (dialogOpen) { setDialogOpen(false); return; }
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
      if (e.key === 'n') { setDialogOpen(true); return; }
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
  }, [dialogOpen, openId, batchMode, selected, flatIds, cursorId, closeDrawer, openIssue]);

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
            <select value={projectId ?? ''} onChange={e => { setProjectId(e.target.value); closeDrawer(); }}>
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
          {/* T5-28 主题切换：图标显示将切换到的目标主题。 */}
          <button className="icon-btn" aria-label="切换主题" title="切换主题"
            onClick={toggleTheme}>{theme === 'dark' ? '☀' : '🌙'}</button>
          {/* T6-35 桌面通知开关：仅看板隐藏时的后台变更提醒。 */}
          <button className={`icon-btn${notify ? ' on' : ''}`} aria-label="桌面通知" title="桌面通知"
            onClick={() => void toggleNotify()}>🔔</button>
          {/* T6-31 统计面板开关。 */}
          <button className={`icon-btn${statsOpen ? ' on' : ''}`} aria-label="统计" title="统计面板"
            onClick={() => setStatsOpen(o => !o)}>📊</button>
          {/* T7-37 时间线视图开关（激活时替代看板主体）。 */}
          <button className={`icon-btn${timelineOpen ? ' on' : ''}`} aria-label="时间线" title="时间线视图（甘特 lite）"
            onClick={() => setTimelineOpen(o => !o)}>📅</button>
        </div>
      </header>

      <div className="toolbar">
        <input ref={searchInputRef} className="toolbar-search" placeholder="搜索标题/描述…" value={filters.text}
          onChange={e => setFilters(f => ({ ...f, text: e.target.value }))} />
        <select value={filters.assignee} onChange={e => setFilters(f => ({ ...f, assignee: e.target.value }))}>
          <option value="">全部</option>
          {assigneeOptions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={filters.label} onChange={e => setFilters(f => ({ ...f, label: e.target.value }))}>
          <option value="">全部</option>
          {labelOptions.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        {/* T5-27: 泳道分组维度。 */}
        <select title="分组" value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)}>
          <option value="none">无</option>
          <option value="assignee">按负责人</option>
          <option value="label">按标签</option>
        </select>
        {/* T5-26: 批量模式开关。 */}
        <button type="button" className={`btn tiny${batchMode ? ' active' : ''}`}
          onClick={() => { setBatchMode(b => !b); setSelected(new Set()); }}>批量模式</button>
        <div className="sort-toggle">
          <button type="button" className={sortBy === 'priority' ? 'active' : ''}
            onClick={() => setSortBy('priority')}>按优先级</button>
          <button type="button" className={sortBy === 'created' ? 'active' : ''}
            onClick={() => setSortBy('created')}>按创建时间</button>
        </div>
      </div>

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
      {timelineOpen
        ? <Timeline issues={visibleIssues} onOpen={openIssue} />
        : <Board issues={visibleIssues} onOpen={openIssue} blockedByMap={blockedByMap} onDrop={async (id, status) => {
          const issue = issues.find(i => i.id === id);
          if (!issue || issue.status === status) return;
          try {
            await api_.updateIssue(id, { status, version: issue.version });
            showToast(`#${id} → ${status}`);
            await refresh();
          } catch (err) { showToast(`✗ ${(err as Error).message}`); void refresh(); }
        }} emptyHint={filtersActive ? '无匹配任务' : undefined}
          groupBy={groupBy}
          batchMode={batchMode}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          cursorId={cursorId} />}

      {openId && (
        <Drawer issueId={openId} projectId={projectId} onClose={closeDrawer}
          onChanged={() => void refresh()}
          onToast={showToast}
          onOpenIssue={openIssue}
          issues={issues}
          statuses={STATUSES} />
      )}

      <NewIssueDialog open={dialogOpen} projectId={projectId!}
        onClose={() => setDialogOpen(false)}
        onCreated={id => { void refresh(); if (id) openIssue(id); }}
        onError={msg => showToast(`✗ ${msg}`)} />

      {toast && (
        <div className="toast">
          <div>{toast.msg}</div>
          {toast.detail && <div className="toast-detail">{toast.detail}</div>}
        </div>
      )}
    </>
  );
}
