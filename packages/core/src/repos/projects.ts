import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const PROJECT_COLS = `p.id, p.name, p.directory_id AS directoryId, p.default_session_id AS defaultSessionId, COALESCE(d.workspace_path, '') AS workspacePath, COALESCE(d.server_url, '') AS wakeChannel, p.labels, p.created_at AS createdAt`;
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export interface ProjectPatch {
  name?: string;
  labels?: string;
  defaultSessionId?: string | null;
}

export class ProjectRepo {
  constructor(private db: DatabaseSync) {}

  create(input: {
    id?: string; name: string; directoryId?: string;
    /** Legacy route values are used only to create a Directory for older callers. */
    workspacePath?: string; wakeChannel?: string; labels?: string;
    defaultSessionId?: string | null;
  }): string {
    const id = input.id || shortId();
    if (this.get(id)) throw new ConflictError(`project already exists: ${id}`);
    if (!input.name.trim()) throw new ValidationError('name: must not be blank');
    const workspacePath = input.workspacePath?.trim() ?? '';
    const serverUrl = input.wakeChannel?.trim() ?? '';
    let directoryId = input.directoryId;
    if (directoryId) {
      if (!this.db.prepare('SELECT id FROM directories WHERE id = ?').get(directoryId)) {
        throw new NotFoundError(`directory not found: ${directoryId}`);
      }
      // Directory route is authoritative; ignore route fields sent with a project.
    } else {
      // Compatibility for older CLI/MCP clients: turn their route inputs into a Directory.
      const normalizedPath = workspacePath.replaceAll(String.fromCharCode(92), '/');
      const label = normalizedPath.split('/').filter(Boolean).at(-1) || '默认目录';
      const existing = this.db.prepare(
        'SELECT id FROM directories WHERE name = ? AND workspace_path = ? AND server_url = ? ORDER BY created_at LIMIT 1'
      ).get(label, workspacePath, serverUrl) as { id: string } | undefined;
      if (existing) directoryId = existing.id;
      else {
        directoryId = shortId();
        this.db.prepare('INSERT INTO directories (id, name, workspace_path, server_url, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(directoryId, label, workspacePath, serverUrl, now());
      }
    }
    this.db.prepare(
      'INSERT INTO projects (id, name, labels, created_at, directory_id, default_session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, input.name.trim(), input.labels ?? '', now(), directoryId, input.defaultSessionId ?? null);
    return id;
  }

  update(id: string, patch: ProjectPatch): void {
    const project = this.get(id);
    if (!project) throw new NotFoundError(`project not found: ${id}`);
    if (patch.name !== undefined && patch.name.trim() === '') throw new ValidationError('name: must not be blank');
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name.trim()); }
    if (patch.labels !== undefined) { sets.push('labels = ?'); vals.push(patch.labels); }
    if (patch.defaultSessionId !== undefined) { sets.push('default_session_id = ?'); vals.push(patch.defaultSessionId); }
        if (sets.length > 0) {
      vals.push(id);
      this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
  }

  list(): Project[] {
    return this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects p LEFT JOIN directories d ON d.id = p.directory_id ORDER BY p.created_at`).all() as unknown as Project[];
  }

  get(id: string): Project | null {
    return (this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects p LEFT JOIN directories d ON d.id = p.directory_id WHERE p.id = ?`).get(id) as unknown as Project | undefined) ?? null;
  }

  // Deletes the whole project aggregate — comments of its issues, then issues,
  // then the project row. Caller wraps this in a transaction.
  delete(id: string): void {
    this.db.prepare('DELETE FROM comments WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ?)').run(id);
    this.db.prepare('DELETE FROM issues WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
