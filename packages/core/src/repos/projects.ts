import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../types.js';
import { ConflictError } from '../errors.js';

const PROJECT_COLS = 'id, name, workspace_path AS workspacePath, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export class ProjectRepo {
  constructor(private db: DatabaseSync) {}

  create(input: { id?: string; name: string; workspacePath?: string }): string {
    const id = input.id || shortId();
    if (this.get(id)) throw new ConflictError(`project already exists: ${id}`);
    this.db.prepare('INSERT INTO projects (id, name, workspace_path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.name, input.workspacePath ?? '', now());
    return id;
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
