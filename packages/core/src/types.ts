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
  assignee: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IssueDetail extends Issue {
  children: Issue[];
  comments: Comment[];
}

export interface IssuePatch {
  title?: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  labels?: string;
  branch?: string;
  assignee?: string;
  parentId?: string | null;
}

export interface Comment {
  id: string;
  issueId: string;
  author: string;
  body: string;
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
