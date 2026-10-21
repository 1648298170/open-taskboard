// Single-instance lock for the EXTERNAL sidecar only (the embedded engine
// passes no lockKey). O_EXCL file creation stands in for flock: the file holds
// the owner PID and a dead PID is recycled on the next start.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import * as path from 'node:path';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WatchLock { ok: true; release: () => void }
export interface WatchLockHeld { ok: false; holder: number }

/**
 * Mutual exclusion via an O_EXCL lock file: exclusive create + PID write. A
 * lock left by a dead process is detected (stale PID) and reclaimed.
 */
export function acquireWatchLock(lockPath: string): WatchLock | WatchLockHeld {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const claim = (): WatchLock => {
    const fd = openSync(lockPath, 'wx');
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return { ok: true, release: () => { try { unlinkSync(lockPath); } catch { /* already reclaimed */ } } };
  };
  try {
    return claim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return { ok: false, holder: pid };
    unlinkSync(lockPath);
    return claim();
  }
}
