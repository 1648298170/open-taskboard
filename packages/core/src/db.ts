import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inTransaction } from './transactions.js';

// The single place that knows the taskboard database shape:
// PRAGMAs, the base schema DDL (the historical "v0" layout) and the ordered
// migrations layered on top. Idempotent — safe on any db.
export function configureDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      workspace_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_id TEXT REFERENCES issues(id),
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
      labels TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
      assignee TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
    CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
  `);
  runMigrations(db);
}

// Ordered migrations: MIGRATIONS[i] moves a db from user_version i to i+1.
// The base schema above always creates the v0 layout (no start/due dates, no
// activities table, no dependencies table), so fresh databases replay every
// migration and converge with existing ones at user_version === MIGRATIONS.length.
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // v0 → v1: issues gain nullable start/due dates (NULL = unset). SQLite has
  // no multi-add ALTER — two separate statements.
  (db: DatabaseSync) => {
    db.exec('ALTER TABLE issues ADD COLUMN start_date TEXT');
    db.exec('ALTER TABLE issues ADD COLUMN due_date TEXT');
  },
  // v1 → v2: activity stream (one row per issue create/update/comment).
  (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        actor TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_activities_issue ON activities(issue_id);
    `);
  },
  // v2 → v3: task dependencies. Edge (issue_id, depends_on_id) means
  // "issue_id is blocked by depends_on_id"; both FKs cascade so deleting
  // an issue cleans every edge that references it.
  (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS issue_dependencies (
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        depends_on_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, depends_on_id));
      CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON issue_dependencies(depends_on_id);
    `);
  },
  // v3 → v4: issues gain a worktree binding (T2-8). Unlike branch, the column
  // is NOT NULL DEFAULT '' — the semantic "unset" is the empty string, and a
  // patch of null is normalized to '' by the repo layer.
  (db: DatabaseSync) => {
    db.exec("ALTER TABLE issues ADD COLUMN worktree TEXT NOT NULL DEFAULT ''");
  },
  // v4 → v5: archive support (T5-24). NULL = not archived; a timestamp marks
  // the archived moment. listIssues excludes archived rows by default.
  (db: DatabaseSync) => {
    db.exec('ALTER TABLE issues ADD COLUMN archived_at TEXT');
  },
  // v5 → v6: FTS5 full-text search index (T6-30). Rows are application-
  // maintained (Store keeps them in the same transactions as the mutations).
  // Capability-guarded: if the sqlite build lacks FTS5, the virtual table is
  // skipped and Store.search falls back to a LIKE scan — a failed migration
  // at startup would brick the server.
  (db: DatabaseSync) => {
    const { n } = db.prepare(
      "SELECT COUNT(*) AS n FROM pragma_compile_options WHERE compile_options LIKE 'ENABLE_FTS5'"
    ).get() as { n: number };
    if (n === 0) return;
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
        text, ref_id UNINDEXED, kind UNINDEXED, project_id UNINDEXED,
        tokenize='trigram');
    `);
    // Backfill existing content: one row per issue title / description and
    // one per comment body. Comment rows carry the project via JOIN.
    db.exec(`
      INSERT INTO issues_fts (text, ref_id, kind, project_id)
      SELECT title, id, 'issue-title', project_id FROM issues;
      INSERT INTO issues_fts (text, ref_id, kind, project_id)
      SELECT description, id, 'issue-desc', project_id FROM issues;
      INSERT INTO issues_fts (text, ref_id, kind, project_id)
      SELECT c.body, c.id, 'comment', i.project_id
      FROM comments c JOIN issues i ON i.id = c.issue_id;
    `);
  },
  // v6 → v7: exclusive claim/lease (T7-34). claimed_by '' = unclaimed;
  // claimed_at stamps the claim moment; lease_expires_at is the deadline.
  // Expiry is LAZY — no timers: consumers treat an expired lease as
  // unclaimed via activeClaim() until the next claim overwrites the row.
  (db: DatabaseSync) => {
    db.exec("ALTER TABLE issues ADD COLUMN claimed_by TEXT NOT NULL DEFAULT ''");
    db.exec('ALTER TABLE issues ADD COLUMN claimed_at TEXT');
    db.exec('ALTER TABLE issues ADD COLUMN lease_expires_at TEXT');
  },
  // v7 → v8: attachments (T7-39). This table carries METADATA only — file
  // bodies live on disk under <dataDir>/attachments/<issueId>/. Rows cascade
  // away with the issue via FK; the Store separately best-effort-removes the
  // per-issue directory when the issue (or project) is deleted.
  (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        actor TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_attachments_issue ON attachments(issue_id);
    `);
  },
  // v8 → v9: opencode session binding (v0.4) — issues may carry the session
  // they were split from, so @agent wakes continue the same conversation.
  // NULL = unbound (CLI-created tasks, or the session is gone).
  (db: DatabaseSync) => {
    db.exec('ALTER TABLE issues ADD COLUMN session_id TEXT');
  },
  // v9 → v10: per-project wake channel for the data-driven watch routing —
  // TUI URL (e.g. http://127.0.0.1:4097) bound to the project; '' = unbound,
  // falls back to the watch's own --tui-url flag, then headless.
  (db: DatabaseSync) => {
    db.exec("ALTER TABLE projects ADD COLUMN wake_channel TEXT NOT NULL DEFAULT ''");
  },
  // v10 → v11: free-form project labels (comma-separated, same convention as
  // issue labels) for grouping/filtering in the UI and automation scripts.
  (db: DatabaseSync) => {
    db.exec("ALTER TABLE projects ADD COLUMN labels TEXT NOT NULL DEFAULT ''");
  },
];

// Applies pending migrations in order, stamping PRAGMA user_version after
// each one. Version check makes it idempotent: already-migrated dbs skip.
// Each migration runs in its own transaction together with its version stamp
// (user_version is transactional in sqlite) — a failure mid-migration rolls
// the DDL back, so the next start replays from a clean state instead of
// dying on duplicate columns.
export function runMigrations(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) break;
    inTransaction(db, () => {
      migrate(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

// Opens the database file under dataDir and configures it.
export function createDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'taskboard.sqlite'));
  configureDatabase(db);
  return db;
}
