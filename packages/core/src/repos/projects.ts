import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../types.js';
import { ConflictError } from '../errors.js';

const PROJECT_COLS = 'id, name, workspace_path AS workspacePath, wake_channel AS wakeChannel, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export interface ProjectPatch {
  name?: string;
  /** Full TUI URL; '' clears the binding. */
  wakeChannel?: string;
}

export class ProjectRepo {
  constructor(private db: DatabaseSync) {}

  create(input: { id?: string; name: string; workspacePath?: string; wakeChannel?: string }): string {
    const id = input.id || shortId();
    if (this.get(id)) throw new ConflictError(`project already exists: ${id}`);
    this.db.prepare('INSERT INTO projects (id, name, workspace_path, wake_channel, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.workspacePath ?? '', input.wakeChannel ?? '', now());
    return id;
  }

  update(id: string, patch: ProjectPatch): void {    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.wakeChannel !== undefined) { sets.push('wake_channel = ?'); vals.push(patch.wakeChannel); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
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
