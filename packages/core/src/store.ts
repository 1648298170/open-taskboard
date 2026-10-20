import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWakeComment, STATUSES, activeClaim } from './types.js';
import type {
  Activity, Attachment, Comment, DependencyEdge, Issue, IssuePatch, Priority, Progress, Project, Status, Stats, StoreEvent, WorkspaceDirectory
} from './types.js';
import { ConflictError, NotFoundError, PermissionError, ValidationError } from './errors.js';
import { configureDatabase, createDatabase } from './db.js';
import { EventBus } from './events.js';
import { inTransaction } from './transactions.js';
import { ProjectRepo } from './repos/projects.js';
import { DirectoryRepo, type DirectoryCreateInput, type DirectoryPatchInput } from './repos/directories.js';
import { IssueRepo } from './repos/issues.js';
import { CommentRepo } from './repos/comments.js';
import { ActivityRepo } from './repos/activities.js';
import { DependencyRepo } from './repos/dependencies.js';
import { SearchRepo } from './repos/search.js';
import { AttachmentRepo } from './repos/attachments.js';

const now = (): string => new Date().toISOString();

// Per-issue attachment quotas (enforced in addAttachment before any write).
const MAX_ISSUE_ATTACHMENTS = 20;
const MAX_ISSUE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// T6-31 stats helpers -------------------------------------------------------
// Monday 00:00 LOCAL of the given date (getDay(): 0=Sun…6=Sat → shifted 0=Mon…6=Sun).
const mondayOf = (d: Date): Date => {
  const shifted = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  shifted.setDate(shifted.getDate() - ((d.getDay() + 6) % 7));
  return shifted;
};
const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Patch keys that map to a writable column, in repo colMap order — used to
// build the activity detail ("status,title", "startDate", ...).
const PATCH_KEYS: (keyof IssuePatch)[] = [
  'title', 'description', 'status', 'priority', 'labels', 'branch', 'worktree', 'worktreePath',
  'sessionId', 'assignee', 'parentId', 'startDate', 'dueDate', 'acceptanceCriteria', 'reviewStatus', 'reviewNotes'
];

/**
 * Resolve the opencode session an issue is created with. Precedence:
 * explicit body value → agentSessionId → project default → null. Every value
 * is trimmed; '' / whitespace / null mean "absent" (never "force unbound"),
 * so the first non-empty binding wins.
 */
export function resolveIssueSessionId(
  explicit?: string | null,
  agentSession?: string | null,
  projectSession?: string | null
): string | null {
  for (const candidate of [explicit, agentSession, projectSession]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// Facade over the repo layer: owns transaction boundaries, event emission,
// and cross-aggregate preconditions. Same public API as before, plus an
// optional DatabaseSync injection seam for tests; callers using
// new Store(dataDir) are unaffected.
export class Store {
  private db: DatabaseSync;
  private events = new EventBus();
  private projects: ProjectRepo;
  private directories: DirectoryRepo;
  private issues: IssueRepo;
  private comments: CommentRepo;
  private activities: ActivityRepo;
  private deps: DependencyRepo;
  private fts: SearchRepo;
  private attachments: AttachmentRepo;
  /** Whether issues_fts exists — fixed for this db right after migrations ran. */
  private readonly ftsAvailable: boolean;

  // db is the DI seam: pass a pre-opened DatabaseSync (e.g. ':memory:') to
  // skip file setup and test this layer directly. It still gets PRAGMAs +
  // schema applied — both are idempotent. attachmentsDir (T7-39) defaults
  // to <dataDir>/attachments; it is created lazily on the first upload, so
  // in-memory stores that never touch attachments leave no directories.
  constructor(dataDir = '.data', db?: DatabaseSync, attachmentsDir?: string) {
    this.db = db ?? createDatabase(dataDir);
    if (db) configureDatabase(db);
    this.projects = new ProjectRepo(this.db);
    this.directories = new DirectoryRepo(this.db);
    this.issues = new IssueRepo(this.db);
    this.comments = new CommentRepo(this.db);
    this.activities = new ActivityRepo(this.db);
    this.deps = new DependencyRepo(this.db);
    this.fts = new SearchRepo(this.db);
    this.ftsAvailable = this.fts.available();
    this.attachments = new AttachmentRepo(this.db, attachmentsDir ?? join(dataDir, 'attachments'));
  }

  /** Run an index-sync helper only when the FTS table exists (no-op otherwise). */
  private syncFts(fn: () => void): void {
    if (this.ftsAvailable) fn();
  }

  subscribe(fn: (event: StoreEvent) => void): () => void {
    return this.events.subscribe(fn);
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.events.emit({ type, payload, revision: this.revision(), at: now() });
  }

  private logActivity(issueId: string, actor: string, action: string, detail: string): void {
    this.activities.record(issueId, actor, action, detail);
  }

  revision(): number {
    return this.db.prepare(
      `SELECT (SELECT COUNT(*) FROM directories)
             + (SELECT COUNT(*) FROM projects) * 10
             + (SELECT COUNT(*) FROM issues) * 100
             + (SELECT COUNT(*) FROM comments) * 1000
             + (SELECT COUNT(*) FROM issue_dependencies) * 10000
             + (SELECT COUNT(*) FROM attachments) * 100000
             + (SELECT COALESCE(SUM(version),0) FROM issues) AS rev`
    ).get()!.rev as number;
  }

  // ---- application settings ----
  getAppSettings(): { defaultWorkspacePath: string; defaultOpenCodeServerUrl: string } {
    const rows = this.db.prepare(
      "SELECT key, value FROM app_settings WHERE key IN ('default_workspace_path', 'default_opencode_server_url')"
    ).all() as { key: string; value: string }[];
    const values = new Map(rows.map(row => [row.key, row.value]));
    return {
      defaultWorkspacePath: values.get('default_workspace_path') ?? '',
      defaultOpenCodeServerUrl: values.get('default_opencode_server_url') ?? ''
    };
  }

  updateAppSettings(patch: { defaultWorkspacePath?: string; defaultOpenCodeServerUrl?: string }): {
    defaultWorkspacePath: string; defaultOpenCodeServerUrl: string;
  } {
    const statements: Array<[string, string | undefined]> = [
      ['default_workspace_path', patch.defaultWorkspacePath],
      ['default_opencode_server_url', patch.defaultOpenCodeServerUrl]
    ];
    for (const [key, value] of statements) {
      if (value === undefined) continue;
      this.db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value.trim());
    }
    return this.getAppSettings();
  }

  // ---- workspace directories ----
  createDirectory(input: DirectoryCreateInput): WorkspaceDirectory {
    const id = this.directories.create(input);
    this.emit('directory.created', { id });
    return this.directories.get(id)!;
  }

  updateDirectory(id: string, patch: DirectoryPatchInput): WorkspaceDirectory {
    inTransaction(this.db, () => this.directories.update(id, patch));
    this.emit('directory.updated', { id, fields: Object.keys(patch) });
    return this.directories.get(id)!;
  }

  listDirectories(): WorkspaceDirectory[] {
    return this.directories.list();
  }

  getDirectory(id: string): WorkspaceDirectory | null {
    return this.directories.get(id);
  }

  deleteDirectory(id: string, options: { cascadeProjects?: boolean } = {}): void {
    const directory = this.directories.get(id);
    if (!directory) throw new NotFoundError(`directory not found: ${id}`);
    const projectIds = this.projects.list()
      .filter(project => project.directoryId === id)
      .map(project => project.id);
    if (projectIds.length > 0 && !options.cascadeProjects) {
      throw new ValidationError('directory is not empty; move or delete its projects first');
    }
    // deleteProject already owns the full per-project cascade (issues, comments,
    // dependencies, FTS, activities and attachment files). Run it per project,
    // then remove the now-empty directory.
    for (const projectId of projectIds) this.deleteProject(projectId);
    inTransaction(this.db, () => this.directories.delete(id));
    this.emit('directory.deleted', { id, projectIds });
  }

  // ---- projects ----
  createProject(input: { id?: string; name: string; directoryId?: string; defaultSessionId?: string | null; workspacePath?: string; wakeChannel?: string; labels?: string }): Project {
    const id = this.projects.create(input);
    this.emit('project.created', { id, directoryId: this.projects.get(id)?.directoryId ?? null });
    return this.projects.get(id)!;
  }

  updateProject(id: string, patch: { name?: string; workspacePath?: string; wakeChannel?: string; labels?: string; defaultSessionId?: string | null }): Project {
    const current = this.projects.get(id);
    if (!current) throw new NotFoundError(`project not found: ${id}`);
    if (patch.name !== undefined && patch.name.trim() === '') throw new ValidationError('name: must not be blank');
    const routingChanged =
      (patch.workspacePath !== undefined && patch.workspacePath.trim() !== current.workspacePath) ||
      (patch.wakeChannel !== undefined && patch.wakeChannel.trim() !== current.wakeChannel);
    if (routingChanged) {
      const activeIssues = this.issues.list(id, { archived: 'all' }).filter(issue => activeClaim(issue));
      if (activeIssues.length > 0) {
        throw new ConflictError(
          `cannot change project workspace/server while ${activeIssues.length} task(s) have active agent leases; release or wait for the leases to expire first`
        );
      }
    }
    const effectivePatch = routingChanged && patch.defaultSessionId === undefined
      ? { ...patch, defaultSessionId: null }
      : patch;
    const unboundIssueIds: string[] = [];
    inTransaction(this.db, () => {
      this.projects.update(id, effectivePatch);
      if (routingChanged) {
        // A task's sessionId is meaningful only in the project server + path
        // context. Clear bindings when that context changes to prevent routing
        // an old session ID to a different OpenCode server or directory.
        for (const issue of this.issues.list(id, { archived: 'all' })) {
          if (!issue.sessionId) continue;
          this.issues.update(issue.id, { sessionId: null });
          this.logActivity(issue.id, 'system', 'session-unbound', 'Project workspace/server changed; bind a session again');
          unboundIssueIds.push(issue.id);
        }
      }
    });
    for (const issueId of unboundIssueIds) this.emit('issue.updated', { id: issueId, fields: ['sessionId'] });
    this.emit('project.updated', { id, fields: Object.keys(effectivePatch), unboundIssueIds });
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
    // Attachment dirs live on disk outside sqlite — collect the issue ids
    // BEFORE the rows vanish, then best-effort-remove each dir after commit.
    const issueIds = this.issues.list(id, { archived: 'all' }).map(i => i.id);
    inTransaction(this.db, () => {
      // FTS first: every fts row carries project_id, and the rows it points
      // at are about to disappear.
      this.syncFts(() => this.fts.deleteProjectFts(id));
      this.projects.delete(id);
    });
    for (const issueId of issueIds) this.rmAttachmentDir(issueId);
    this.emit('project.deleted', { id });
  }

  // ---- issues ----
  createIssue(input: {
    projectId: string; parentId?: string | null; title: string;
    description?: string; status?: Status; priority?: Priority;
    labels?: string; branch?: string; worktree?: string | null; worktreePath?: string | null; assignee?: string;
    sessionId?: string | null;
    startDate?: string | null; dueDate?: string | null;
    acceptanceCriteria?: string; reviewStatus?: 'pending' | 'approved' | 'changes_requested'; reviewNotes?: string;
  }, actor = '', agentSessionId: string | null = null): Issue {
    const parentId = input.parentId ?? null;
    const project = this.projects.get(input.projectId);
    if (!project) throw new NotFoundError(`project not found: ${input.projectId}`);
    // Explicit body → caller's agent session → project default → unbound.
    const sessionId = resolveIssueSessionId(input.sessionId, agentSessionId, project.defaultSessionId);
    const parent = parentId ? this.issues.get(parentId) : null;
    if (parentId && !parent) throw new NotFoundError(`parent issue not found: ${parentId}`);
    if (parent && parent.parentId) throw new ValidationError('only one level of nesting is supported (parent must be a top-level issue)');
    if (parent && parent.projectId !== input.projectId) throw new ValidationError('parent issue belongs to a different project');
    const id = inTransaction(this.db, () => {
      const issueId = this.issues.create({
        projectId: input.projectId, parentId, title: input.title,
        description: input.description, status: input.status, priority: input.priority,
        labels: input.labels, branch: input.branch, worktree: input.worktree, worktreePath: input.worktreePath,
        sessionId,
        assignee: input.assignee,
        startDate: input.startDate, dueDate: input.dueDate,
        acceptanceCriteria: input.acceptanceCriteria, reviewStatus: input.reviewStatus, reviewNotes: input.reviewNotes
      });
      this.syncFts(() => this.fts.indexIssue(issueId, input.projectId, input.title, input.description ?? ''));
      this.logActivity(issueId, actor, 'created', input.title);
      const created = this.issues.get(issueId)!;
      if (created.status === 'in_review' || created.status === 'done') {
        this.flowParentOnChildrenReview(created, actor);
      }
      return issueId;
    });
    this.emit('issue.created', { id, projectId: input.projectId });
    return this.issues.get(id)!;
  }

  getIssue(id: string): Issue | null {
    return this.issues.get(id);
  }

  listIssues(projectId: string, opts: { status?: Status; parentId?: string | null; includeDone?: boolean; archived?: 'only' | 'all' } = {}): Issue[] {
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
    // Moving a parent under another parent would push its children to depth 3,
    // where nothing renders or counts them — the two-level invariant wins.
    if (this.issues.list(cur.projectId, { parentId: id, archived: 'all' }).length > 0) {
      throw new ValidationError('cannot re-parent an issue that has children');
    }
  }

  updateIssue(id: string, patch: IssuePatch, expectedVersion?: number, actor = '', statusNote?: string): Issue {
    this.assertParentPatch(id, patch);
    const cur = this.issues.get(id);
    if (!cur) throw new NotFoundError(`issue not found: ${id}`);
    // Activity detail: the changed keys joined by ','; a status change also
    // spells out the transition (e.g. "status: todo→in_progress,title").
    const detail = PATCH_KEYS
      .filter(k => patch[k] !== undefined)
      .map(k => k === 'status' && patch.status ? `status: ${cur.status}→${patch.status}` : k)
      .join(',');
    const statusChanged = patch.status !== undefined && patch.status !== cur.status;
    // Domain-managed timestamps: first start is immutable across retries; reopening clears completion.
    const effectivePatch: IssuePatch = { ...patch };
    const transitionAt = statusChanged ? now() : null;
    if (statusChanged && patch.status === 'in_progress' && cur.startedAt === null) {
      effectivePatch.startedAt = transitionAt;
    }
    if (statusChanged && patch.status === 'done' && cur.completedAt === null) {
      effectivePatch.completedAt = transitionAt;
    } else if (statusChanged && cur.status === 'done' && patch.status !== 'done') {
      effectivePatch.completedAt = null;
    }
    const suppliedNote = statusNote?.trim() ?? '';
    // Defense in depth: HTTP validates this too, but a named non-web actor must
    // never move a status without a note. Web board actions get an explicit,
    // honest automatic audit comment when no explanation was supplied.
    if (statusChanged && actor.trim() !== '' && actor !== 'web' && !suppliedNote) {
      throw new ValidationError('status changes require statusNote; include the reason, verification evidence, and any unchecked items');
    }
    const effectiveNote = statusChanged
      ? suppliedNote || (actor === 'web' ? 'Taskboard 网页人工操作；操作者未提供额外说明。' : '')
      : '';
    const transactionResult = inTransaction(this.db, () => {
      let auditComment: Comment | null = null;
      const result = this.issues.update(id, effectivePatch, expectedVersion);
      if (result.changed) {
        // Title/description may have moved — refresh both fts rows.
        const updated = this.issues.get(id)!;
        this.syncFts(() => this.fts.reindexIssue(id, updated.projectId, updated.title, updated.description));
        this.logActivity(id, actor, 'updated', detail);
        if (statusChanged && effectiveNote) {
          const body = `状态变更记录：${cur.status} → ${patch.status}\n${effectiveNote}`;
          const commentId = this.comments.add(id, { author: actor || 'system', body });
          this.syncFts(() => this.fts.indexComment(commentId, updated.projectId, body));
          this.logActivity(id, actor || 'system', 'commented', body.slice(0, 200));
          auditComment = this.comments.get(commentId);
        }
        if (patch.status === 'in_progress' && cur.status !== 'in_progress') {
          this.flowParentOnChildStart(cur, actor);
        }
        if ((patch.status === 'in_review' || patch.status === 'done') && cur.status !== patch.status) {
          this.flowParentOnChildrenReview(cur, actor);
        }
      }
      return { changed: result.changed, auditComment };
    });
    if (transactionResult.changed) this.emit('issue.updated', { id });
    if (transactionResult.changed && transactionResult.auditComment) {
      const comment = transactionResult.auditComment;
      this.emit('comment.created', {
        id: comment.id,
        issueId: id,
        author: comment.author,
        body: comment.body.slice(0, 200),
        status: comment.status,
        issueTitle: this.issues.get(id)!.title
      });
    }
    return this.issues.get(id)!;
  }

  deleteIssue(id: string): void {
    if (!this.issues.get(id)) throw new NotFoundError(`issue not found: ${id}`);
    const deleted = inTransaction(this.db, () => {
      // FTS cleanup FIRST — deleteIssueFts resolves comment rows via a
      // subquery over the still-intact comments table, for the whole subtree.
      this.syncFts(() => {
        for (const sub of this.issues.subtreeIds(id)) this.fts.deleteIssueFts(sub);
      });
      return this.issues.deleteRecursively(id);
    });
    // T7-39: attachment bodies live on disk — best-effort removal per deleted
    // id (rows already cascaded inside the transaction); a locked file must
    // never fail the delete itself.
    for (const deletedId of deleted) this.rmAttachmentDir(deletedId);
    for (const deletedId of deleted) this.emit('issue.deleted', { id: deletedId });
  }

  /** Best-effort `rm -rf` of one issue's attachment dir; never throws. */
  private rmAttachmentDir(issueId: string): void {
    try { rmSync(this.attachments.dirPath(issueId), { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // ---- archive (T5-24): a row mutation — bumps version + updated_at like
  // updateIssue so optimistic-lock clients see the change. Archiving a parent
  // brings its non-archived children along: a visible child under an archived
  // parent loses its lane grouping and vanishes from the board. Unarchive is
  // single-row on purpose (a manually archived child stays archived). ----
  archiveIssue(id: string, actor = ''): Issue {
    const cur = this.issues.get(id);
    if (!cur) throw new NotFoundError(`issue not found: ${id}`);
    if (cur.archivedAt) return cur;
    // Default list filter = non-archived children only ('only' would select
    // already-archived rows, the exact complement of what cascades).
    const kids = this.issues.list(cur.projectId, { parentId: id });
    inTransaction(this.db, () => {
      this.issues.setArchived(id, now());
      this.logActivity(id, actor, 'archived', '');
      for (const kid of kids) {
        this.issues.setArchived(kid.id, now());
        this.logActivity(kid.id, actor, 'archived', `with parent ${id}`);
      }
    });
    for (const changedId of [id, ...kids.map(k => k.id)]) this.emit('issue.updated', { id: changedId });
    return this.issues.get(id)!;
  }

  unarchiveIssue(id: string, actor = ''): Issue {
    const cur = this.issues.get(id);
    if (!cur) throw new NotFoundError(`issue not found: ${id}`);
    if (!cur.archivedAt) return cur;
    inTransaction(this.db, () => {
      this.issues.setArchived(id, null);
      this.logActivity(id, actor, 'unarchived', '');
    });
    this.emit('issue.updated', { id });
    return this.issues.get(id)!;
  }

  // ---- claims / leases (T7-34): exclusive task pickup ----
  // Expiry is lazy — no timers anywhere. A claim is ACTIVE iff
  // activeClaim(issue) returns the holder (claimedBy set + lease deadline in
  // the future); expired rows read as unclaimed until overwritten.

  /**
   * When a child starts (claim auto-flow or a manual move to in_progress),
   * pull a `todo` parent up to `in_progress` in the same transaction — the
   * workstream as a whole has started. One-way from todo only: in_review /
   * done stay human-decided (全子 done 也绝不自动关闭父任务).
   */
  private flowParentOnChildStart(child: Issue, actor: string): void {
    if (!child.parentId) return;
    const parent = this.issues.get(child.parentId);
    if (!parent || parent.status !== 'todo') return;
    this.issues.update(parent.id, { status: 'in_progress', ...(parent.startedAt === null ? { startedAt: now() } : {}) });
    this.logActivity(parent.id, actor, 'status', 'todo → in_progress (child started)');
  }

  /**
   * When every child is waiting for review (`in_review` or `done`), roll the
   * parent up to `in_review` in the same transaction. This keeps the review
   * column honest without ever auto-completing the parent: `done` stays
   * human-decided.
   */
  private flowParentOnChildrenReview(child: Issue, actor: string): void {
    if (!child.parentId) return;
    const parent = this.issues.get(child.parentId);
    if (!parent || (parent.status !== 'todo' && parent.status !== 'in_progress')) return;
    const children = this.issues.list(parent.projectId, { parentId: parent.id, archived: 'all' });
    if (children.length === 0) return;
    if (!children.every(item => item.status === 'in_review' || item.status === 'done')) return;
    this.issues.update(parent.id, { status: 'in_review', ...(parent.startedAt === null ? { startedAt: now() } : {}) });
    this.logActivity(parent.id, actor, 'status', `${parent.status} -> in_review (all children waiting for review)`);
  }

  /**
   * Take (or renew) the exclusive lease of an issue. Re-entrant for the same
   * agent — a second claim simply renews. Another holder's ACTIVE claim →
   * ConflictError; an expired lease is fair game. Bumps version + updated_at
   * like archiveIssue and logs a 'claimed' activity. A claimable `todo` is
   * auto-moved to `in_progress` in the same transaction (认领即开工，dashi
   * 语义): the board's in_progress column never lies about started work.
   * When `sessionId` is given and the issue is unbound, it binds the
   * claimer's session in the same transaction (认领即绑定); an existing
   * binding is never overwritten (只绑空位，不抢绑).
   */
  claimIssue(id: string, agent: string, ttlMinutes = 30, actor = agent, sessionId?: string, branch?: string): Issue {
    if (!agent) throw new ValidationError('agent must be non-empty');
    const issue = this.issues.get(id);
    if (!issue) throw new NotFoundError(`issue not found: ${id}`);
    const holder = activeClaim(issue);
    if (holder !== null && holder !== agent) {
      throw new ConflictError(`issue claimed by ${holder} until ${issue.leaseExpiresAt}`);
    }
    const t = now();
    const expires = new Date(Date.parse(t) + ttlMinutes * 60_000).toISOString();
    // CAS against the holder we observed — another process (two serve
    // instances / MCP auto-start races) may have claimed in between.
    let claimed = false;
    inTransaction(this.db, () => {
      claimed = this.issues.setClaim(id, agent, t, expires, issue.claimedBy);
      if (!claimed) return;
      this.logActivity(id, actor, 'claimed', `by ${agent} ttl ${ttlMinutes}m`);
      // dashi 语义：认领即开工 —— todo 单向自动流转，「进行中」列从此
      // 机器级真实（agent 想跳过都跳不掉）。in_review/done 不回退。
      if (issue.status === 'todo') {
        this.issues.update(id, { status: 'in_progress', ...(issue.startedAt === null ? { startedAt: t } : {}) });
        this.logActivity(id, actor, 'status', 'todo → in_progress (claim)');
      }
      // 认领即绑定：只绑空位，绝不接管他人会话的绑定（所有权语义）。
      if (sessionId && !issue.sessionId) {
        this.issues.update(id, { sessionId });
        this.logActivity(id, actor, 'session-bound', sessionId);
      }
      // 同一规则的分支版：开工即绑当前分支，只绑空位（branch-bound 留痕）。
      if (branch && !issue.branch) {
        this.issues.update(id, { branch });
        this.logActivity(id, actor, 'branch-bound', branch);
      }
      // 子任务开工 → 父任务拉起（同一聚合真相：这组工作已经启动）。
      this.flowParentOnChildStart(issue, actor);
    });
    if (!claimed) throw new ConflictError('claim state changed concurrently, retry');
    this.emit('issue.updated', { id });
    return this.issues.get(id)!;
  }

  /**
   * Renew the caller's lease (heartbeat). A pure lease op, deliberately NOT
   * a row mutation: no version bump, no updated_at touch, no activity — a
   * renewal must not invalidate optimistic-lock clients or spam the activity
   * stream. Still emits 'issue.updated' so live boards refresh the badge.
   * Non-holder or expired lease → ConflictError (expired means claim again).
   */
  heartbeatIssue(id: string, agent: string, ttlMinutes = 30): Issue {
    if (!agent) throw new ValidationError('agent must be non-empty');
    const issue = this.issues.get(id);
    if (!issue) throw new NotFoundError(`issue not found: ${id}`);
    const holder = activeClaim(issue);
    if (holder === null) throw new ConflictError('lease expired, claim again');
    if (holder !== agent) throw new ConflictError('not the lease holder');
    if (!this.issues.extendLease(id, new Date(Date.now() + ttlMinutes * 60_000).toISOString(), agent)) {
      throw new ConflictError('not the lease holder');
    }
    this.emit('issue.updated', { id });
    return this.issues.get(id)!;
  }

  /**
   * Give the lease back. Clearing an ACTIVE claim bumps version + updated_at
   * and logs a 'released' activity; releasing an unclaimed or expired issue
   * is an idempotent no-op (success without side effects). Another holder's
   * ACTIVE claim → ConflictError.
   */
  releaseIssue(id: string, agent: string, actor = agent): Issue {
    if (!agent) throw new ValidationError('agent must be non-empty');
    const issue = this.issues.get(id);
    if (!issue) throw new NotFoundError(`issue not found: ${id}`);
    const holder = activeClaim(issue);
    if (holder !== null && holder !== agent) throw new ConflictError('not the lease holder');
    if (holder !== null) {
      let released = false;
      inTransaction(this.db, () => {
        released = this.issues.clearClaim(id, agent);
        if (released) this.logActivity(id, actor, 'released', `by ${agent}`);
      });
      if (!released) throw new ConflictError('not the lease holder');
      this.emit('issue.updated', { id });
    }
    return this.issues.get(id)!;
  }

  // ---- comments ----
  addComment(issueId: string, input: { author?: string; body: string }, actor = ''): Comment {
    const issue = this.issues.get(issueId);
    if (!issue) throw new NotFoundError(`issue not found: ${issueId}`);
    const id = inTransaction(this.db, () => {
      const commentId = this.comments.add(issueId, input);
      this.syncFts(() => this.fts.indexComment(commentId, this.issues.get(issueId)!.projectId, input.body));
      this.logActivity(issueId, actor, 'commented', input.body.slice(0, 200));
      // A wake comment on a settled task re-opens it (agent took over work
      // again) — in_review/done → in_progress, one-way, with its own activity
      // line and issue.updated event so every client notices immediately.
      if (isWakeComment(input.body)
        && (issue.status === 'in_review' || issue.status === 'done')) {
        this.issues.update(issueId, {
          status: 'in_progress',
          ...(issue.startedAt === null ? { startedAt: now() } : {}),
          ...(issue.status === 'done' ? { completedAt: null } : {})
        });
        this.logActivity(issueId, actor, 'updated', `status: ${issue.status}→in_progress (wake)`);
      }
      return commentId;
    });
    // Payload carries author/body-excerpt/issueTitle so webhook & SSE
    // consumers (e.g. the watch sidecar) can decide without a follow-up GET.
    this.emit('comment.created', {
      id, issueId,
      author: input.author ?? '',
      body: input.body.slice(0, 200),
      status: this.comments.get(id)!.status,
      issueTitle: issue.title
    });
    if (issue.status !== this.issues.get(issueId)!.status) this.emit('issue.updated', { id: issueId });
    return this.comments.get(id)!;
  }

  // Editing a comment re-queues it for the watcher: the only state machine is
  // pending → processing (a wake addressed it) → processed (the headless run
  // finished / human confirmed). Body edits are allowed only while pending —
  // an in-flight or finished instruction must keep its original meaning.
  // Back to pending = "wake it again": emits comment.updated so the watch
  // sidecar re-runs it without the human retyping the instruction.
  updateComment(id: string, patch: { body?: string; status?: string }, actor = ''): Comment {
    const cur = this.comments.get(id);
    if (!cur) throw new NotFoundError(`comment not found: ${id}`);
    if (patch.body !== undefined && cur.status !== 'pending') {
      throw new ValidationError(`comment ${id} is ${cur.status}; only pending comments can be edited`);
    }
    if (patch.body !== undefined && !patch.body.trim()) {
      throw new ValidationError('comment body cannot be blank');
    }
    // 编辑权限（人类评论保护）：只有经 web 面板创建署名（author='web' 或历史
    // 匿名空签名）的评论，才可被 web 来源编辑；agent 的一切 body 编辑被拒，
    // agent 创建的评论谁都不可编辑（保持 agent 发言原样，避免事后篡改）。
    // 状态推进永远放行（watch/agent 需要推进 pending → processing → processed）。
    if (patch.body !== undefined) {
      const mine = cur.author === 'web' || cur.author === '';
      if (actor !== 'web' || !mine) {
        throw new PermissionError(
          !mine
            ? `comment ${id} was created by agent '${cur.author}' and can never be edited`
            : `only the web user who created comment ${id} may edit it`
        );
      }
    }
    const issueId = cur.issueId;
    const issueTitle = this.issues.get(issueId)?.title ?? '';
    const before = this.issues.get(issueId)?.status;
    inTransaction(this.db, () => {
      this.comments.update(id, patch, issueId);
      if (patch.body !== undefined) {
        this.syncFts(() => {
          this.fts.deleteCommentFts(id);
          this.fts.indexComment(id, this.issues.get(issueId)!.projectId, patch.body!);
        });
      }
      this.logActivity(issueId, actor,
        patch.body !== undefined ? 'comment-edited' : 'comment-status',
        (patch.body ?? cur.body).slice(0, 200));
      // Same reopen contract as addComment — including the same predicate: only
      // a *wake* comment may re-open a settled task. Without the body check,
      // re-queueing any plain comment to pending would silently drop the task
      // back to in_progress with no wake at all.
      if (patch.status === 'pending'
        && isWakeComment(patch.body ?? cur.body)
        && (before === 'in_review' || before === 'done')) {
        this.issues.update(issueId, {
          status: 'in_progress',
          ...(cur.startedAt === null ? { startedAt: now() } : {}),
          ...(before === 'done' ? { completedAt: null } : {})
        });
        this.logActivity(issueId, actor, 'updated', `status: ${before}→in_progress (wake)`);
      }
    });
    const updated = this.comments.get(id)!;
    if (patch.body !== undefined || patch.status !== undefined) {
      this.emit('comment.updated', {
        id, issueId,
        body: updated.body.slice(0, 200),
        status: updated.status,
        issueTitle
      });
    }
    if (before !== this.issues.get(issueId)!.status) this.emit('issue.updated', { id: issueId });
    return updated;
  }

  // Deleting a comment mirrors adding one: same transaction shape, FTS row
  // dropped, activity logged, event emitted — and like add, it never bumps
  // the issue version (only updated_at moves).
  deleteComment(id: string, actor = ''): void {
    const comment = this.comments.get(id);
    if (!comment) throw new NotFoundError(`comment not found: ${id}`);
    const issueTitle = this.issues.get(comment.issueId)?.title ?? '';
    inTransaction(this.db, () => {
      this.syncFts(() => this.fts.deleteCommentFts(id));
      this.comments.delete(id, comment.issueId);
      this.logActivity(comment.issueId, actor, 'comment-deleted', comment.body.slice(0, 200));
    });
    this.emit('comment.deleted', {
      id, issueId: comment.issueId,
      author: comment.author,
      body: comment.body.slice(0, 200),
      issueTitle
    });
  }

  getComment(id: string): Comment | null {
    return this.comments.get(id);
  }

  /** 该任务上某作者（actor）的评论数——in_review 门禁的判定依据。 */
  commentCountBy(issueId: string, author: string): number {
    return this.comments.countByAuthor(issueId, author);
  }

  listComments(issueId: string): Comment[] {
    return this.comments.list(issueId);
  }

  // ---- activities: latest first, capped by the repo (default 50) ----
  listActivities(issueId: string): Activity[] {
    return this.activities.listByIssue(issueId);
  }

  /** Persist an Agent/watch dispatch outcome in the task timeline. */
  recordExecutionEvent(
    issueId: string,
    outcome: 'started' | 'queued' | 'running' | 'idle' | 'retrying' | 'succeeded' | 'failed',
    detail: string,
    actor = 'watch'
  ): Activity {
    if (!this.issues.get(issueId)) throw new NotFoundError(`issue not found: ${issueId}`);
    const normalized = detail.trim().slice(0, 2000);
    if (!normalized) throw new ValidationError('execution event detail is required');
    const activity = inTransaction(this.db, () => {
      this.logActivity(issueId, actor, 'execution', `[${outcome}] ${normalized}`);
      return this.activities.listByIssue(issueId, 1)[0]!;
    });
    this.emit('issue.updated', { id: issueId });
    return activity;
  }

  // ---- attachments (T7-39): metadata rows in sqlite, bodies on disk ----

  /**
   * Record one attachment: metadata row + 'attachment' activity (detail =
   * filename) + 'issue.updated' event (live boards + SSE refresh). The
   * caller writes the body via attachmentPathFor right after — a failed
   * write leaves an orphan row whose download 404s, which beats an
   * on-disk orphan nobody can discover.
   */
  addAttachment(issueId: string, filename: string, size: number, actor = ''): Attachment {
    if (!this.issues.get(issueId)) throw new NotFoundError(`issue not found: ${issueId}`);
    const existing = this.attachments.listByIssue(issueId);
    if (existing.length >= MAX_ISSUE_ATTACHMENTS) {
      throw new ValidationError(`attachment quota exceeded: ${issueId} already holds ${existing.length}/${MAX_ISSUE_ATTACHMENTS} files`);
    }
    const usedBytes = existing.reduce((sum, a) => sum + a.size, 0);
    if (usedBytes + size > MAX_ISSUE_ATTACHMENT_BYTES) {
      throw new ValidationError(`attachment quota exceeded: ${existing.length} files / ${usedBytes} bytes used of ${MAX_ISSUE_ATTACHMENT_BYTES} byte quota — ${filename} (${size} bytes) does not fit`);
    }
    const attachment = inTransaction(this.db, () => {
      const row = this.attachments.record(issueId, filename, size, actor);
      this.logActivity(issueId, actor, 'attachment', filename);
      return row;
    });
    this.emit('issue.updated', { id: issueId });
    return attachment;
  }

  /**
   * Persist an uploaded attachment as one logical operation. The body is first
   * written to a temporary file; the metadata row and final atomic rename then
   * happen inside the SQLite transaction. If any step fails, remove temporary
   * or final files so the database never advertises a body that was not saved.
   */
  addAttachmentWithBody(issueId: string, filename: string, body: Uint8Array, actor = ''): Attachment {
    if (!this.issues.get(issueId)) throw new NotFoundError(`issue not found: ${issueId}`);
    const existing = this.attachments.listByIssue(issueId);
    if (existing.length >= MAX_ISSUE_ATTACHMENTS) {
      throw new ValidationError(`attachment quota exceeded: ${issueId} already holds ${existing.length}/${MAX_ISSUE_ATTACHMENTS} files`);
    }
    const usedBytes = existing.reduce((sum, attachment) => sum + attachment.size, 0);
    if (usedBytes + body.byteLength > MAX_ISSUE_ATTACHMENT_BYTES) {
      throw new ValidationError(`attachment quota exceeded: ${existing.length} files / ${usedBytes} bytes used of ${MAX_ISSUE_ATTACHMENT_BYTES} byte quota — ${filename} (${body.byteLength} bytes) does not fit`);
    }

    const directory = this.attachmentDirFor(issueId);
    const temporaryPath = join(directory, `.upload-${randomUUID()}.tmp`);
    let finalPath = '';
    try {
      writeFileSync(temporaryPath, body, { flag: 'wx' });
      const attachment = inTransaction(this.db, () => {
        const row = this.attachments.record(issueId, filename, body.byteLength, actor);
        finalPath = this.attachmentPathFor(issueId, row.id, filename);
        renameSync(temporaryPath, finalPath);
        this.logActivity(issueId, actor, 'attachment', filename);
        return row;
      });
      this.emit('issue.updated', { id: issueId });
      return attachment;
    } catch (error) {
      for (const path of [temporaryPath, finalPath]) {
        if (!path || !existsSync(path)) continue;
        try { unlinkSync(path); } catch { /* best-effort rollback cleanup */ }
      }
      throw error;
    }
  }

  listAttachments(issueId: string): Attachment[] {
    return this.attachments.listByIssue(issueId);
  }

  getAttachment(id: string): Attachment | null {
    return this.attachments.get(id);
  }

  /** Per-issue attachment directory on disk, created on demand (server upload path). */
  attachmentDirFor(issueId: string): string {
    return this.attachments.dirFor(issueId);
  }

  /** On-disk path of one attachment body (ensures the parent dir exists). */
  attachmentPathFor(issueId: string, attachmentId: string, filename: string): string {
    return this.attachments.pathFor(issueId, attachmentId, filename);
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

  // ---- stats (T6-31): 统计面板聚合 ----

  /**
   * Aggregate project stats: weekly done throughput (last N Monday-based
   * weeks, zero-filled, oldest → newest), average cycle hours over done
   * issues, per-actor activity counts (top 10), and the current per-status
   * breakdown in STATUSES order.
   *
   * weeklyDone buckets DONE issues by updatedAt — a PROXY for completion
   * time (the schema has no dedicated completed_at column; any later patch
   * re-buckets the issue, an accepted approximation). weekStart is Monday
   * 00:00 local formatted YYYY-MM-DD; weeks defaults to 8, clamped 1..26.
   * Like projectProgress, archived issues are excluded (listIssues default)
   * and unknown projects stay the route layer's business (404 there).
   */
  projectStats(projectId: string, opts: { weeks?: number } = {}): Stats {
    const weeks = Math.min(26, Math.max(1, Math.trunc(opts.weeks ?? 8)));
    const all = this.issues.list(projectId);

    // Weekly buckets oldest → newest, zero-filled up front.
    const thisMonday = mondayOf(new Date());
    const weeklyDone: { weekStart: string; count: number }[] = [];
    const bucketIndex = new Map<string, number>();
    for (let k = weeks - 1; k >= 0; k--) {
      const weekStart = isoDay(new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * k));
      bucketIndex.set(weekStart, weeklyDone.length);
      weeklyDone.push({ weekStart, count: 0 });
    }
    const doneIssues = all.filter(i => i.status === 'done');
    for (const issue of doneIssues) {
      const idx = bucketIndex.get(isoDay(mondayOf(new Date(issue.updatedAt))));
      if (idx !== undefined) weeklyDone[idx]!.count++;
    }

    // avgCycleHours = mean(updatedAt − createdAt) over done issues, hours,
    // rounded to 1 decimal; null when nothing is done yet.
    let avgCycleHours: number | null = null;
    if (doneIssues.length > 0) {
      const totalMs = doneIssues.reduce(
        (sum, i) => sum + Date.parse(i.updatedAt) - Date.parse(i.createdAt), 0
      );
      avgCycleHours = Math.round(((totalMs / doneIssues.length) / 3_600_000) * 10) / 10;
    }

    return {
      weeklyDone,
      avgCycleHours,
      byActor: this.activities.countByActorForProject(projectId),
      byStatus: STATUSES.map(status => ({ status, count: all.filter(i => i.status === status).length }))
    };
  }

  // ---- dependencies: edge (issueId, dependsOnId) = "issueId is blocked by dependsOnId" ----

  /** All ids transitively reachable from `from` along depends-on edges (incl. `from`). */
  private transitiveDependsOn(from: string): Set<string> {
    const visited = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const next of this.deps.directDependsOn(cur)) stack.push(next);
    }
    return visited;
  }

  addDependency(issueId: string, dependsOnId: string, actor = ''): void {
    const issue = this.issues.get(issueId);
    if (!issue) throw new NotFoundError(`issue not found: ${issueId}`);
    const target = this.issues.get(dependsOnId);
    if (!target) throw new NotFoundError(`issue not found: ${dependsOnId}`);
    if (issue.projectId !== target.projectId) throw new ValidationError('dependencies must stay within one project');
    if (issueId === dependsOnId) throw new ValidationError('an issue cannot depend on itself');
    // Adding issueId→dependsOnId cycles iff dependsOnId already (transitively)
    // depends on issueId — i.e. issueId is reachable from dependsOnId.
    if (this.transitiveDependsOn(dependsOnId).has(issueId)) {
      throw new ValidationError('circular dependency detected');
    }
    inTransaction(this.db, () => {
      this.deps.add(issueId, dependsOnId, now());
      this.logActivity(issueId, actor, 'dependency-added', `depends on ${dependsOnId}`);
    });
    this.emit('issue.updated', { id: issueId });
  }

  removeDependency(issueId: string, dependsOnId: string, actor = ''): void {
    if (!this.issues.get(issueId)) throw new NotFoundError(`issue not found: ${issueId}`);
    if (!this.issues.get(dependsOnId)) throw new NotFoundError(`issue not found: ${dependsOnId}`);
    if (!this.deps.exists(issueId, dependsOnId)) throw new ValidationError('dependency does not exist');
    inTransaction(this.db, () => {
      this.deps.remove(issueId, dependsOnId);
      this.logActivity(issueId, actor, 'dependency-removed', `no longer depends on ${dependsOnId}`);
    });
    this.emit('issue.updated', { id: issueId });
  }

  listDependencies(issueId: string): { blockedBy: string[]; blocks: string[] } {
    return this.deps.listForIssue(issueId);
  }

  projectDependencies(projectId: string): DependencyEdge[] {
    return this.deps.listByProject(projectId);
  }

  /**
   * Issues whose every depends-on issue is done (and that are not done
   * themselves), in the standard listIssues priority order. With opts.assignee,
   * only issues assigned to that exact assignee. With opts.claimAgent (T7-34),
   * issues carrying another agent's ACTIVE claim are excluded — the caller's
   * own claims and expired leases stay eligible. Default (no claimAgent):
   * no exclusion, the UI needs to display claimed items.
   */
  readyIssues(projectId: string, opts: { assignee?: string; claimAgent?: string } = {}): Issue[] {
    const blockedBy = new Map<string, string[]>();
    for (const edge of this.deps.listByProject(projectId)) {
      const list = blockedBy.get(edge.issueId);
      if (list) list.push(edge.dependsOnId);
      else blockedBy.set(edge.issueId, [edge.dependsOnId]);
    }
    // T5-24 × T4-20/21: include archived rows so a done-then-archived
    // dependency still counts as done — archiving hides a card from the
    // board, it must not un-ready its dependents.
    const statusById = new Map(this.issues.list(projectId, { archived: 'all' }).map(i => [i.id, i.status]));
    const isReady = (id: string): boolean =>
      (blockedBy.get(id) ?? []).every(dep => statusById.get(dep) === 'done');
    const claimableBy = (issue: Issue): boolean => {
      if (opts.claimAgent === undefined) return true;
      const holder = activeClaim(issue);
      return holder === null || holder === opts.claimAgent;
    };
    return this.listIssues(projectId, { includeDone: false })
      .filter(i => isReady(i.id)
        && (opts.assignee === undefined || i.assignee === opts.assignee)
        && claimableBy(i));
  }

  // ---- search (T6-30) ----

  /**
   * Full-text search across issue titles/descriptions and comment bodies
   * (trigram, ≥3 chars); a comment hit maps to its parent issue. Shorter
   * queries — and engines whose build skipped the FTS5 migration — fall
   * back to a case-insensitive LIKE scan over title/description/comment
   * bodies. Archived issues are excluded, matching the listIssues default.
   */
  search(query: string): Issue[] {
    const q = query.trim();
    if (!q) return [];
    if (!this.ftsAvailable || q.length < 3) return this.fts.likeScan(q);
    // Wrap as a quoted phrase so user input can never break FTS syntax;
    // embedded double quotes are stripped first (a stray quote would error).
    const phrase = q.replace(/"/g, '');
    if (!phrase) return [];
    const hits = this.fts.match(`"${phrase}"`);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      let issueId: string | null = null;
      if (hit.kind === 'issue-title' || hit.kind === 'issue-desc') issueId = hit.refId;
      else if (hit.kind === 'comment') {
        const c = this.comments.get(hit.refId);
        issueId = c ? c.issueId : null;
      }
      if (issueId && !seen.has(issueId)) { seen.add(issueId); ids.push(issueId); }
    }
    const out: Issue[] = [];
    for (const id of ids) {
      const issue = this.issues.get(id);
      if (issue && !issue.archivedAt) out.push(issue);
    }
    return out;
  }

  // ---- backup (T6-32) ----

  /**
   * VACUUM INTO a compact snapshot under `dir` (created recursively if
   * missing); returns the written file path (taskboard-YYYYMMDD-HHMMSS.sqlite).
   * Cannot run inside a transaction — call outside any unit of work
   * (the server does it right after listen). NUL bytes are rejected; single
   * quotes in the path are escaped by doubling.
   */
  backupTo(dir: string): string {
    if (dir.includes('\0')) throw new ValidationError('backup dir must not contain NUL bytes');
    mkdirSync(dir, { recursive: true });
    const t = new Date();
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const file = join(dir, `taskboard-${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}.sqlite`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return file;
  }
}
