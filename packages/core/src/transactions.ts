import type { DatabaseSync } from 'node:sqlite';

// Runs fn inside BEGIN/COMMIT; on any failure (including COMMIT itself)
// rolls back and rethrows the original error.
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
