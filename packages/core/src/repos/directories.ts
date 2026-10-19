import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkspaceDirectory } from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const DIRECTORY_COLS = 'id, name, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export interface DirectoryCreateInput {
  id?: string;
  name: string;
}
export interface DirectoryPatchInput {
  name?: string;
}

export class DirectoryRepo {
  constructor(private db: DatabaseSync) {}

  create(input: DirectoryCreateInput): string {
    const id = input.id || shortId();
    if (this.get(id)) throw new ConflictError(`directory already exists: ${id}`);
    if (!input.name.trim()) throw new ValidationError('name: must not be blank');
    this.db.prepare('INSERT INTO directories (id, name, created_at) VALUES (?, ?, ?)')
      .run(id, input.name.trim(), now());
    return id;
  }

  update(id: string, patch: DirectoryPatchInput): void {
    if (!this.get(id)) throw new NotFoundError(`directory not found: ${id}`);
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('name: must not be blank');
    if (patch.name === undefined) return;
    this.db.prepare('UPDATE directories SET name = ? WHERE id = ?').run(patch.name.trim(), id);
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
