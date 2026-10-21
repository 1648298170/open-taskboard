// SSE 刷新的纯逻辑（框架无关）：事件类型路由 + trailing 合并。
// 一次 store 变更会同时产生多条 change 事件（父任务/子任务/评论/唤醒状态机），
// 直接逐条全量刷新会把请求量放大 5-7 倍；这里把同一窗口内的事件折叠成最多
// 一次 loadProjects + 一次 refresh。
import type { SseChangeEvent } from '../api';

/** 一条事件会让哪一份数据变旧。 */
export type SseRoute = 'projects' | 'issues' | 'both';

const PROJECT_PREFIXES = ['project.', 'directory.'];
const ISSUE_PREFIXES = ['issue.', 'comment.', 'dependency.'];

/**
 * project/directory → 侧栏（loadProjects）；issue/comment/dependency → 看板
 * （refresh）；hello 与未知类型 → 两边都刷（安全兜底，宁可多刷不漏刷）。
 */
export function classifySseEvent(type: string): SseRoute {
  if (PROJECT_PREFIXES.some(prefix => type.startsWith(prefix))) return 'projects';
  if (ISSUE_PREFIXES.some(prefix => type.startsWith(prefix))) return 'issues';
  return 'both';
}

/** 只有当前打开的任务（或重连 hello）才需要重取抽屉详情。 */
export function affectsOpenIssue(event: SseChangeEvent, openId: string | null): boolean {
  if (openId === null) return false;
  if (event.type === 'hello') return true;
  return event.issueId !== null && event.issueId === openId;
}

export interface SseBatchHandlers {
  /** 侧栏项目/目录需要重取。 */
  onProjects: () => void;
  /** 看板任务/进度/依赖需要重取。 */
  onIssues: () => void;
  /** 抽屉详情需要重取（已由 affectsOpenIssue 过滤）。 */
  onDetail: () => void;
}

export interface SseBatcher {
  push: (event: SseChangeEvent, openId: string | null) => void;
  dispose: () => void;
}

/**
 * Trailing 合并：每次 push 重置窗口，窗口静默后才 flush，因此一波 N 条事件
 * 对每个 handler 最多触发一次。flush 先清标记再调用 handler——handler 期间
 * 到达的事件会开启下一个窗口，不会被吞掉。
 */
export function createSseBatcher(handlers: SseBatchHandlers, delayMs = 250): SseBatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let projectsDirty = false;
  let issuesDirty = false;
  let detailDirty = false;

  const flush = (): void => {
    timer = null;
    const runProjects = projectsDirty;
    const runIssues = issuesDirty;
    const runDetail = detailDirty;
    projectsDirty = false;
    issuesDirty = false;
    detailDirty = false;
    if (runProjects) handlers.onProjects();
    if (runIssues) handlers.onIssues();
    if (runDetail) handlers.onDetail();
  };

  return {
    push(event, openId) {
      const route = classifySseEvent(event.type);
      if (route !== 'issues') projectsDirty = true;
      if (route !== 'projects') issuesDirty = true;
      if (affectsOpenIssue(event, openId)) detailDirty = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      projectsDirty = false;
      issuesDirty = false;
      detailDirty = false;
    }
  };
}
