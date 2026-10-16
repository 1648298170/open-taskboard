import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Attachment } from '../types.js';

const ATTACHMENT_COLS = 'id, issue_id AS issueId, filename, size, actor, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

// T7-39 attachment repository. sqlite holds metadata rows ONLY; the bodies
// live on disk under <attachmentsDir>/<issueId>/<attachmentId>__<filename>.
// Rows cascade away with the issue (FK); directory cleanup is the caller's
// (Store's) best-effort business.
export class AttachmentRepo {
  constructor(private db: DatabaseSync, private attachmentsDir: string) {}

  /** Insert one metadata row (generated shortId) and return it; the caller owns writing the body. */
  record(issueId: string, filename: string, size: number, actor: string): Attachment {
    const id = shortId();
    const t = now();
    this.db.prepare(
      'INSERT INTO attachments (id, issue_id, filename, size, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, issueId, filename, size, actor, t);
    return { id, issueId, filename, size, actor, createdAt: t };
  }

  get(id: string): Attachment | null {
    return this.db.prepare(`SELECT ${ATTACHMENT_COLS} FROM attachments WHERE id = ?`).get(id) as unknown as Attachment | null;
  }

  // rowid tie-breaker: same-millisecond uploads still come back in insertion order.
  listByIssue(issueId: string): Attachment[] {
    return this.db.prepare(
      `SELECT ${ATTACHMENT_COLS} FROM attachments WHERE issue_id = ? ORDER BY created_at, rowid`
    ).all(issueId) as unknown as Attachment[];
  }

  /** Per-issue directory path WITHOUT touching the filesystem (cleanup path). */
  dirPath(issueId: string): string {
    return join(this.attachmentsDir, issueId);
  }

  /** Per-issue directory on disk, created on demand (upload path). */
  dirFor(issueId: string): string {
    const dir = this.dirPath(issueId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** On-disk path of one attachment body (ensures the parent dir exists). */
  pathFor(issueId: string, attachmentId: string, filename: string): string {
    return join(this.dirFor(issueId), `${attachmentId}__${filename}`);
  }
}
