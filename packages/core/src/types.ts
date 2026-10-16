export const STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
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
  /** Archive timestamp (T5-24); null = not archived. */
  archivedAt: string | null;
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
  assignee?: string;
  parentId?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
}

export interface Comment {
  id: string;
  issueId: string;
  author: string;
  body: string;
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

export interface Progress {
  total: number;
  done: number;
  topTotal: number;
  topDone: number;
  weightedDone: number;
  weightedTotal: number;
}

export interface StoreEvent {
  type: string;
  payload: Record<string, unknown>;
  revision: number;
  at: string;
}
