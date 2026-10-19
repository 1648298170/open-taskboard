export const STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
/** Wake prefix — a comment starting with this asks the watch sidecar (or any
 *  receiver) to summon an agent; addComment re-opens settled tasks on it. */
export const WAKE_PREFIX = '@agent';

/**
 * Single source of truth for "does this comment wake an agent?".
 *
 * Leading whitespace is tolerated on purpose: the Store re-opens settled tasks
 * with the same predicate, so the web editor (where a stray leading newline is
 * easy to paste) and the watch sidecar must agree — otherwise a comment can
 * re-open a task without ever being delivered, or vice versa.
 */
export function isWakeComment(body: string, prefix: string = WAKE_PREFIX): boolean {
  return body.trimStart().startsWith(prefix);
}

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface WorkspaceDirectory {
  id: string;
  name: string;
  path: string;
  serverUrl: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  /** Parent workspace directory shown in the sidebar. */
  directoryId: string | null;
  /** Optional session preselected when creating tasks in this project. */
  defaultSessionId: string | null;
  workspacePath: string;
  /** TUI URL (e.g. http://127.0.0.1:4097) the watch delivers this project's wakes to; '' = unbound. */
  wakeChannel: string;
  labels: string;
  createdAt: string;
}

export interface Issue {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string;
  branch: string;
  /** Bound git worktree name (T2-8); empty string = unbound. */
  worktree: string;
  /** opencode session this task was split from (v0.4); null = unbound. */
  sessionId: string | null;
  /** Archive timestamp (T5-24); null = not archived. */
  archivedAt: string | null;
  /** Exclusive claim holder (T7-34); '' = unclaimed. */
  claimedBy: string;
  /** Claim lease deadline (T7-34); null or in the past = no active claim. */
  leaseExpiresAt: string | null;
  assignee: string;
  version: number;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetail extends Issue {
  children: Issue[];
  comments: Comment[];
  activities: Activity[];
  /** T7-39: attachment metadata rows (bodies live on disk), oldest first. */
  attachments: Attachment[];
  /** ids of issues this one is blocked by (edge issue_id = this id). */
  blockedBy: string[];
  /** ids of issues blocked by this one (edge depends_on_id = this id). */
  blocks: string[];
}

/** Dependency edge: issueId is blocked by dependsOnId. */
export interface DependencyEdge {
  issueId: string;
  dependsOnId: string;
}

export interface IssuePatch {
  title?: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  labels?: string;
  branch?: string;
  /** T2-8: null clears (stored as ''); the column itself is NOT NULL ''. */
  worktree?: string | null;
  /** v0.4: opencode session binding; null = unbind. */
  sessionId?: string | null;
  assignee?: string;
  parentId?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
}

export type CommentStatus = 'pending' | 'processing' | 'processed';

export interface Comment {
  id: string;
  issueId: string;
  author: string;
  body: string;
  status: CommentStatus;
  createdAt: string;
}

export interface Activity {
  id: string;
  issueId: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

/**
 * T7-39: one attachment metadata row. The file BODY is stored on disk at
 * `<attachmentsDir>/<issueId>/<attachmentId>__<filename>` — sqlite never
 * sees file content, only this index card.
 */
export interface Attachment {
  id: string;
  issueId: string;
  filename: string;
  /** Byte size of the stored file. */
  size: number;
  actor: string;
  createdAt: string;
}

export interface Progress {
  total: number;
  done: number;
  topTotal: number;
  topDone: number;
  weightedDone: number;
  weightedTotal: number;
}

/** T6-31: 项目统计面板。 */
export interface Stats {
  /** 近 N 周每周完成任务数（周一起算，零填充，最旧 → 最新）。 */
  weeklyDone: { weekStart: string; count: number }[];
  /** 完成任务的平均周期（updatedAt − createdAt，小时，1 位小数）；无完成任务时为 null。 */
  avgCycleHours: number | null;
  /** 各 agent 的操作数（activities ⋈ issues 按项目聚合，count 降序，最多 10 个）。 */
  byActor: { actor: string; actions: number }[];
  /** 各状态当前任务数（STATUSES 顺序，含 0）。 */
  byStatus: { status: Status; count: number }[];
}

export interface StoreEvent {
  type: string;
  payload: Record<string, unknown>;
  revision: number;
  at: string;
}

/**
 * T7-34: the effective claim holder of an issue, or null when unclaimed.
 * A claim is ACTIVE iff claimedBy is set AND leaseExpiresAt is in the
 * future — expiry is lazy (no timers), so an expired lease reads as
 * unclaimed even though the row fields stay until the next claim
 * overwrites them. Shared by store / server / web so every consumer
 * applies the same rule.
 */
export function activeClaim(issue: Pick<Issue, 'claimedBy' | 'leaseExpiresAt'>): string | null {
  return issue.claimedBy !== ''
    && issue.leaseExpiresAt !== null
    && Date.parse(issue.leaseExpiresAt) > Date.now()
    ? issue.claimedBy
    : null;
}
