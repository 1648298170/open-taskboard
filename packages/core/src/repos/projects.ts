import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const PROJECT_COLS = 'id, name, directory_id AS directoryId, default_session_id AS defaultSessionId, workspace_path AS workspacePath, wake_channel AS wakeChannel, labels, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export interface ProjectPatch {
  name?: string;
  labels?: string;
  workspacePath?: string;
  wakeChannel?: string;
  defaultSessionId?: string | null;
}

export class ProjectRepo {
  constructor(private db: DatabaseSync) {}

  create(input: {
    id?: string; name: string; directoryId?: string;
    workspacePath?: string; wakeChannel?: string; labels?: string;
    defaultSessionId?: string | null;
  }): string {
    const id = input.id || shortId();
    if (this.get(id)) throw new ConflictError(`project already exists: ${id}`);
    if (!input.name.trim()) throw new ValidationError('name: must not be blank');

    let workspacePath = input.workspacePath?.trim() ?? '';
    const wakeChannel = input.wakeChannel?.trim() ?? '';
    let directoryId = input.directoryId;
    if (directoryId) {
      const directory = this.db.prepare('SELECT id, workspace_path AS workspacePath FROM directories WHERE id = ?').get(directoryId) as { id: string; workspacePath: string } | undefined;
      if (!directory) throw new NotFoundError(`directory not found: ${directoryId}`);
      if (!workspacePath) workspacePath = directory.workspacePath;
    } else {
      // Legacy CLI/MCP clients do not send directoryId. Directories are only
      // sidebar groups now: reuse a group with the same display name, or create
      // one from the workspace basename and initialize its default workspace path.
      const label = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || '默认目录';
      const existing = this.db.prepare(
        'SELECT id FROM directories WHERE name = ? ORDER BY created_at LIMIT 1'
      ).get(label) as { id: string } | undefined;
      if (existing) {
        directoryId = existing.id;
      } else {
        directoryId = shortId();
        this.db.prepare(
          'INSERT INTO directories (id, name, workspace_path, created_at) VALUES (?, ?, ?, ?)'
        ).run(directoryId, label, workspacePath, now());
      }
    }

    this.db.prepare(
      'INSERT INTO projects (id, name, workspace_path, wake_channel, labels, created_at, directory_id, default_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.name.trim(), workspacePath, wakeChannel, input.labels ?? '', now(), directoryId, input.defaultSessionId ?? null);
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
    if (patch.workspacePath !== undefined) { sets.push('workspace_path = ?'); vals.push(patch.workspacePath.trim()); }
    if (patch.wakeChannel !== undefined) { sets.push('wake_channel = ?'); vals.push(patch.wakeChannel.trim()); }
    if (sets.length > 0) {
      vals.push(id);
      this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
  }

  list(): Project[] {
    return this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects ORDER BY created_at`).all() as unknown as Project[];
  }

  get(id: string): Project | null {
    return this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as unknown as Project | null;
  }

  // Deletes the whole project aggregate — comments of its issues, then issues,
  // then the project row. Caller wraps this in a transaction.
  delete(id: string): void {
    this.db.prepare('DELETE FROM comments WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ?)').run(id);
    this.db.prepare('DELETE FROM issues WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
