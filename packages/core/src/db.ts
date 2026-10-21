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

const hasTable = (db: DatabaseSync, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);

/**
 * v12 -> v13 directory grouping, written idempotently so it can also repair a
 * database produced by the earlier project-session line. That line also
 * stamped user_version 13, but with a different schema (projects.session_id
 * instead of directories). Existing rows are grouped by workspace path and
 * server URL; the backfill only runs when no directory exists yet.
 */
function migrateWorkspaceDirectories(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS directories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);`);
  if (!hasColumn(db, 'projects', 'directory_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN directory_id TEXT REFERENCES directories(id)');
  }
  if (!hasColumn(db, 'projects', 'default_session_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN default_session_id TEXT');
  }
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM directories').get() as { c: number };
  if (c === 0) {
    db.exec(`
      DROP TABLE IF EXISTS directory_migration_map;
      CREATE TEMP TABLE directory_migration_map (
        workspace_path TEXT NOT NULL,
        server_url TEXT NOT NULL,
        directory_id TEXT NOT NULL,
        PRIMARY KEY (workspace_path, server_url)
      );
      INSERT INTO directory_migration_map (workspace_path, server_url, directory_id)
      SELECT workspace_path, wake_channel, lower(hex(randomblob(4)))
      FROM projects
      GROUP BY workspace_path, wake_channel;
      INSERT INTO directories (id, name, created_at)
      SELECT m.directory_id,
             CASE WHEN m.workspace_path <> '' THEN m.workspace_path ELSE '默认目录' END,
             MIN(p.created_at)
      FROM directory_migration_map m
      JOIN projects p ON p.workspace_path = m.workspace_path AND p.wake_channel = m.server_url
      GROUP BY m.directory_id, m.workspace_path;
      UPDATE projects
      SET directory_id = (
        SELECT m.directory_id FROM directory_migration_map m
        WHERE m.workspace_path = projects.workspace_path AND m.server_url = projects.wake_channel
        LIMIT 1
      );
      DROP TABLE directory_migration_map;
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_directory ON projects(directory_id)');
}

/**
 * Reconcile databases whose user_version was stamped by a divergent migration
 * line (both master and this branch once used version 13). The function is
 * idempotent and only fills in schema that is missing; it never rewinds data.
 */
function ensureSchemaCompatibility(db: DatabaseSync, version: number): void {
  if (version < 13) return;
  if (!hasTable(db, 'directories')) {
    migrateWorkspaceDirectories(db);
  } else {
    if (!hasColumn(db, 'projects', 'directory_id')) {
      db.exec('ALTER TABLE projects ADD COLUMN directory_id TEXT REFERENCES directories(id)');
    }
    if (!hasColumn(db, 'projects', 'default_session_id')) {
      db.exec('ALTER TABLE projects ADD COLUMN default_session_id TEXT');
    }
  }
  if (version >= 14 && !hasColumn(db, 'directories', 'workspace_path')) {
    db.exec("ALTER TABLE directories ADD COLUMN workspace_path TEXT NOT NULL DEFAULT ''");
    db.exec(`
      UPDATE directories
      SET workspace_path = COALESCE((
        SELECT p.workspace_path FROM projects p
        WHERE p.directory_id = directories.id AND p.workspace_path <> ''
        ORDER BY p.created_at LIMIT 1
      ), '')
    `);
  }
  if (version >= 15 && !hasTable(db, 'app_settings')) {
    db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')");
    db.exec("INSERT INTO app_settings (key, value) VALUES ('default_workspace_path', '')");
  }
  // The project-session line stored the binding in projects.session_id.
  // Preserve it when both columns exist so no binding is silently lost.
  if (hasColumn(db, 'projects', 'session_id') && hasColumn(db, 'projects', 'default_session_id')) {
    db.exec(`
      UPDATE projects
      SET default_session_id = session_id
      WHERE (default_session_id IS NULL OR default_session_id = '')
        AND session_id IS NOT NULL AND session_id <> ''
    `);
  }
  // Repair a database whose version stamp came from a divergent migration line.
  if (version >= 17 && hasTable(db, 'issues')) {
    if (!hasColumn(db, 'issues', 'worktree_path')) db.exec("ALTER TABLE issues ADD COLUMN worktree_path TEXT NOT NULL DEFAULT ''");
    if (!hasColumn(db, 'issues', 'started_at')) db.exec('ALTER TABLE issues ADD COLUMN started_at TEXT');
    if (!hasColumn(db, 'issues', 'completed_at')) db.exec('ALTER TABLE issues ADD COLUMN completed_at TEXT');
    if (!hasColumn(db, 'issues', 'acceptance_criteria')) db.exec("ALTER TABLE issues ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT ''");
    if (!hasColumn(db, 'issues', 'review_status')) db.exec("ALTER TABLE issues ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'");
    if (!hasColumn(db, 'issues', 'review_notes')) db.exec("ALTER TABLE issues ADD COLUMN review_notes TEXT NOT NULL DEFAULT ''");
  }
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
  // v11 → v12: comment lifecycle — only pending comments may be edited or
  // re-wake the agent; processing/processed are locked by the wake watcher.
  (db: DatabaseSync) => {
    db.exec("ALTER TABLE comments ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  },
  // v12 → v13: workspace directories group projects in the sidebar. Existing
  // projects are grouped by their current workspace path + OpenCode server,
  // preserving the configuration they already use.
  migrateWorkspaceDirectories,
  // v13 → v14: a directory may provide a default workspace path for new projects.
  // Backfill from an existing project in each directory to preserve migrated setups.
  (db: DatabaseSync) => {
    db.exec("ALTER TABLE directories ADD COLUMN workspace_path TEXT NOT NULL DEFAULT ''");
    db.exec(`
      UPDATE directories
      SET workspace_path = COALESCE((
        SELECT p.workspace_path FROM projects p
        WHERE p.directory_id = directories.id AND p.workspace_path <> ''
        ORDER BY p.created_at LIMIT 1
      ), '')
    `);
  },
  // v14 → v15: persistent application-level defaults shared by all browser clients.
  (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO app_settings (key, value) VALUES ('default_workspace_path', '');
    `);
  },
  // v15 → v16: a directory carries the OpenCode Server URL inherited by the
  // projects created under it. Backfill from an existing project so migrated
  // directories keep working without manual re-entry.
  (db: DatabaseSync) => {
    db.exec("ALTER TABLE directories ADD COLUMN server_url TEXT NOT NULL DEFAULT ''");
    db.exec(`
      UPDATE directories
      SET server_url = COALESCE((
        SELECT p.wake_channel FROM projects p
        WHERE p.directory_id = directories.id AND p.wake_channel <> ''
        ORDER BY p.created_at LIMIT 1
      ), '')
    `);
  },
  // v16 → v17: execution context, lifecycle timestamps, and human review fields.
  // Existing rows remain NULL/pending; we do not fabricate historical timestamps.
  (db: DatabaseSync) => {
    db.exec(`
      ALTER TABLE issues ADD COLUMN worktree_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE issues ADD COLUMN started_at TEXT;
      ALTER TABLE issues ADD COLUMN completed_at TEXT;
      ALTER TABLE issues ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '';
      ALTER TABLE issues ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE issues ADD COLUMN review_notes TEXT NOT NULL DEFAULT '';
    `);
  },
  // v17 -> v18: move the last duplicated routing values into Directory, then
  // remove Project's physical copies. API Project fields are computed from its
  // owning Directory for compatibility with existing consumers.
  (db: DatabaseSync) => {
    db.exec(`
      UPDATE directories
      SET workspace_path = COALESCE(NULLIF(workspace_path, ''), (
        SELECT p.workspace_path FROM projects p
        WHERE p.directory_id = directories.id AND p.workspace_path <> ''
        ORDER BY p.created_at LIMIT 1
      ), '');
      UPDATE directories
      SET server_url = COALESCE(NULLIF(server_url, ''), (
        SELECT p.wake_channel FROM projects p
        WHERE p.directory_id = directories.id AND p.wake_channel <> ''
        ORDER BY p.created_at LIMIT 1
      ), '');
    `);
    if (hasColumn(db, 'projects', 'workspace_path')) {
      db.exec('ALTER TABLE projects DROP COLUMN workspace_path');
    }
    if (hasColumn(db, 'projects', 'wake_channel')) {
      db.exec('ALTER TABLE projects DROP COLUMN wake_channel');
    }
  },
  // v18 -> v19: task Session is projected from Project.default_session_id; it is
  // no longer duplicated on each Issue row.
  (db: DatabaseSync) => {
    if (hasColumn(db, 'issues', 'session_id')) {
      db.exec('ALTER TABLE issues DROP COLUMN session_id');
    }
  },
  // v19 -> v20: OpenCode URL is deployment configuration, never persisted per directory or in app settings.
  (db: DatabaseSync) => {
    if (hasColumn(db, 'directories', 'server_url')) db.exec("UPDATE directories SET server_url = ''");
    if (hasTable(db, 'app_settings')) db.exec("DELETE FROM app_settings WHERE key = 'default_opencode_server_url'");
  }
];

// Applies pending migrations in order, stamping PRAGMA user_version after
// each one. Version check makes it idempotent: already-migrated dbs skip.
// Each migration runs in its own transaction together with its version stamp
// (user_version is transactional in sqlite) — a failure mid-migration rolls
// the DDL back, so the next start replays from a clean state instead of
// dying on duplicate columns.
export function runMigrations(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  // Repair databases stamped by the divergent project-session migration line
  // before the regular loop. Their version can already be >= 13 while the
  // directory schema is missing, so the loop alone would start at v14 and fail.
  if (version >= 13) {
    inTransaction(db, () => ensureSchemaCompatibility(db, version));
  }
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
