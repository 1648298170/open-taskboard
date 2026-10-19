import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkspaceDirectory } from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const DIRECTORY_COLS = 'id, name, path, server_url AS serverUrl, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export interface DirectoryCreateInput {
  id?: string;
  name: string;
  path: string;
  serverUrl: string;
}
export interface DirectoryPatchInput {
  name?: string;
  path?: string;
  serverUrl?: string;
}

export class DirectoryRepo {
  constructor(private db: DatabaseSync) {}

  create(input: DirectoryCreateInput): string {
    const id = input.id || shortId();
    if (this.get(id)) throw new ConflictError(`directory already exists: ${id}`);
    if (!input.name.trim()) throw new ValidationError('name: must not be blank');
    if (!input.path.trim()) throw new ValidationError('path: must not be blank');
    this.db.prepare(
      'INSERT INTO directories (id, name, path, server_url, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, input.name.trim(), input.path.trim(), input.serverUrl.trim(), now());
    return id;
  }

  update(id: string, patch: DirectoryPatchInput): void {
    if (!this.get(id)) throw new NotFoundError(`directory not found: ${id}`);
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('name: must not be blank');
    if (patch.path !== undefined && !patch.path.trim()) throw new ValidationError('path: must not be blank');
    const sets: string[] = [];
    const values: string[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name.trim()); }
    if (patch.path !== undefined) { sets.push('path = ?'); values.push(patch.path.trim()); }
    if (patch.serverUrl !== undefined) { sets.push('server_url = ?'); values.push(patch.serverUrl.trim()); }
    if (!sets.length) return;
    values.push(id);
    this.db.prepare(`UPDATE directories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const directory = this.get(id);
    if (directory) {
      this.db.prepare('UPDATE projects SET workspace_path = ?, wake_channel = ? WHERE directory_id = ?')
        .run(directory.path, directory.serverUrl, id);
    }
  }

  list(): WorkspaceDirectory[] {
    return this.db.prepare(`SELECT ${DIRECTORY_COLS} FROM directories ORDER BY created_at, name`)
      .all() as unknown as WorkspaceDirectory[];
  }

  get(id: string): WorkspaceDirectory | null {
    return this.db.prepare(`SELECT ${DIRECTORY_COLS} FROM directories WHERE id = ?`).get(id) as unknown as WorkspaceDirectory | null;
  }

  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError(`directory not found: ${id}`);
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM projects WHERE directory_id = ?').get(id) as { count: number };
    if (row.count > 0) throw new ValidationError('directory is not empty; move or delete its projects first');
    this.db.prepare('DELETE FROM directories WHERE id = ?').run(id);
  }
}
