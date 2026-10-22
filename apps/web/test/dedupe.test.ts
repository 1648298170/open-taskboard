// 短窗口去重：本地变更的主动刷新优先，随后的 SSE 回声被吞掉。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipRefresh, REFRESH_DEDUPE_MS } from '../src/logic/mutationDedupe';

describe('shouldSkipRefresh', () => {
  it('never skips the first refresh (lastAt = 0)', () => {
    assert.equal(shouldSkipRefresh(0, Date.now()), false);
  });

  it('skips duplicates inside the window', () => {
    const t = 1_000_000;
    assert.equal(shouldSkipRefresh(t, t + 1), true);
    assert.equal(shouldSkipRefresh(t, t + REFRESH_DEDUPE_MS - 1), true);
  });

  it('allows refreshes at or after the window boundary', () => {
    const t = 1_000_000;
    assert.equal(shouldSkipRefresh(t, t + REFRESH_DEDUPE_MS), false);
    assert.equal(shouldSkipRefresh(t, t + REFRESH_DEDUPE_MS + 1), false);
  });

  it('never skips on a non-monotonic clock reading', () => {
    assert.equal(shouldSkipRefresh(1_000_000, 999_000), false);
  });
});
