import type { DatabaseSync } from 'node:sqlite';
import type {
  Comment, Issue, IssuePatch, Priority, Progress, Project, Status, StoreEvent
} from './types.js';
import { NotFoundError, ValidationError } from './errors.js';
import { configureDatabase, createDatabase } from './db.js';
import { EventBus } from './events.js';
import { inTransaction } from './transactions.js';
import { ProjectRepo } from './repos/projects.js';
import { IssueRepo } from './repos/issues.js';
import { CommentRepo } from './repos/comments.js';

const now = (): string => new Date().toISOString();

// Facade over the repo layer: owns transaction boundaries, event emission,
// and cross-aggregate preconditions. Same public API as before, plus an
// optional DatabaseSync injection seam for tests; callers using
// new Store(dataDir) are unaffected.
export class Store {
  private db: DatabaseSync;
  private events = new EventBus();
  private projects: ProjectRepo;
  private issues: IssueRepo;
  private comments: CommentRepo;

  // db is the DI seam: pass a pre-opened DatabaseSync (e.g. ':memory:') to
  // skip file setup and test this layer directly. It still gets PRAGMAs +
  // schema applied — both are idempotent.
  constructor(dataDir = '.data', db?: DatabaseSync) {
    this.db = db ?? createDatabase(dataDir);
    if (db) configureDatabase(db);
    this.projects = new ProjectRepo(this.db);
    this.issues = new IssueRepo(this.db);
    this.comments = new CommentRepo(this.db);
  }

  subscribe(fn: (event: StoreEvent) => void): () => void {
    return this.events.subscribe(fn);
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.events.emit({ type, payload, revision: this.revision(), at: now() });
  }

  revision(): number {
    return this.db.prepare(
      `SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM issues) * 10
             + (SELECT COUNT(*) FROM comments) * 100
             + (SELECT COALESCE(SUM(version),0) FROM issues) AS rev`
    ).get()!.rev as number;
  }

  // ---- projects ----
  createProject(input: { id?: string; name: string; workspacePath?: string }): Project {
    const id = this.projects.create(input);
    this.emit('project.created', { id });
    return this.projects.get(id)!;
  }

  listProjects(): Project[] {
    return this.projects.list();
  }

  getProject(id: string): Project | null {
    return this.projects.get(id);
  }

  deleteProject(id: string): void {
    if (!this.projects.get(id)) throw new NotFoundError(`project not found: ${id}`);
    inTransaction(this.db, () => this.projects.delete(id));
    this.emit('project.deleted', { id });
  }

  // ---- issues ----
  createIssue(input: {
    projectId: string; parentId?: string | null; title: string;
    description?: string; status?: Status; priority?: Priority;
    labels?: string; branch?: string; assignee?: string;
  }): Issue {
    const parentId = input.parentId ?? null;
    if (!this.projects.get(input.projectId)) throw new NotFoundError(`project not found: ${input.projectId}`);
    const parent = parentId ? this.issues.get(parentId) : null;
    if (parentId && !parent) throw new NotFoundError(`parent issue not found: ${parentId}`);
    if (parent && parent.parentId) throw new ValidationError('only one level of nesting is supported (parent must be a top-level issue)');
    if (parent && parent.projectId !== input.projectId) throw new ValidationError('parent issue belongs to a different project');
    const id = this.issues.create({
      projectId: input.projectId, parentId, title: input.title,
      description: input.description, status: input.status, priority: input.priority,
      labels: input.labels, branch: input.branch, assignee: input.assignee
    });
    this.emit('issue.created', { id, projectId: input.projectId });
    return this.issues.get(id)!;
  }

  getIssue(id: string): Issue | null {
    return this.issues.get(id);
  }

  listIssues(projectId: string, opts: { status?: Status; parentId?: string | null; includeDone?: boolean } = {}): Issue[] {
    return this.issues.list(projectId, opts);
  }

  private assertParentPatch(id: string, patch: IssuePatch): void {
    if (patch.parentId === undefined || patch.parentId === null) return;
    if (patch.parentId === id) throw new ValidationError('an issue cannot be its own parent');
    const cur = this.issues.get(id);
    if (!cur) throw new NotFoundError(`issue not found: ${id}`);
    const parent = this.issues.get(patch.parentId);
    if (!parent) throw new NotFoundError(`parent issue not found: ${patch.parentId}`);
    if (parent.parentId) throw new ValidationError('only one level of nesting is supported (parent must be a top-level issue)');
    if (parent.projectId !== cur.projectId) throw new ValidationError('parent issue belongs to a different project');
  }

  updateIssue(id: string, patch: IssuePatch, expectedVersion?: number): Issue {
    this.assertParentPatch(id, patch);
    const { changed } = this.issues.update(id, patch, expectedVersion);
    if (changed) this.emit('issue.updated', { id });
    return this.issues.get(id)!;
  }

  deleteIssue(id: string): void {
    if (!this.issues.get(id)) throw new NotFoundError(`issue not found: ${id}`);
    const deleted = inTransaction(this.db, () => this.issues.deleteRecursively(id));
    for (const deletedId of deleted) this.emit('issue.deleted', { id: deletedId });
  }

  // ---- comments ----
  addComment(issueId: string, input: { author?: string; body: string }): Comment {
    if (!this.issues.get(issueId)) throw new NotFoundError(`issue not found: ${issueId}`);
    const id = inTransaction(this.db, () => this.comments.add(issueId, input));
    this.emit('comment.created', { id, issueId });
    return this.comments.get(id)!;
  }

  getComment(id: string): Comment | null {
    return this.comments.get(id);
  }

  listComments(issueId: string): Comment[] {
    return this.comments.list(issueId);
  }

  // ---- progress: one top-level issue = one unit, equal weight (dashi #371) ----
  projectProgress(projectId: string): Progress {
    const all = this.issues.list(projectId);
    const top = all.filter(i => !i.parentId);
    const done = (list: Issue[]): number => list.filter(i => i.status === 'done').length;
    const completedTop = top.filter(t =>
      t.status === 'done' ||
      (all.some(i => i.parentId === t.id) && all.filter(i => i.parentId === t.id).every(k => k.status === 'done'))
    ).length;
    return {
      total: all.length,
      done: done(all),
      topTotal: top.length,
      topDone: done(top),
      weightedDone: completedTop,
      weightedTotal: top.length
    };
  }
}
