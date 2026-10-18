// web 纯逻辑单测（node:test + tsx）。覆盖：整组移动规划与 409 重读重试、
// 工具栏过滤组合匹配、泳道构建、卡片扁平序、日期串。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/api';
import type { Issue } from '../src/api';
import { buildLanes, flattenCardOrder, todayStr } from '../src/logic/board';
import { issueMatchesFilters } from '../src/logic/filters';
import { moveWithRetry, pickMovableChildren } from '../src/logic/groupMove';

const mk = (over: Partial<Issue> & Pick<Issue, 'id' | 'title'>): Issue => ({
  projectId: 'p1',
  parentId: null,
  description: '',
  status: 'todo',
  priority: 'medium',
  labels: '',
  branch: '',
  worktree: '',
  sessionId: null,
  archivedAt: null,
  claimedBy: '',
  leaseExpiresAt: null,
  assignee: '',
  version: 1,
  startDate: null,
  dueDate: null,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...over,
  id: over.id,
  title: over.title
});

describe('pickMovableChildren', () => {
  it('selects same-parent children whose status differs from the target', () => {
    const parent = mk({ id: 'p', title: 'parent' });
    const kids = [
      mk({ id: 'a', title: 'a', parentId: 'p', status: 'in_review' }),
      mk({ id: 'b', title: 'b', parentId: 'p', status: 'done' }),
      mk({ id: 'c', title: 'c', parentId: 'p', status: 'done' }),
      mk({ id: 'other', title: 'other parent child', parentId: 'zz', status: 'todo' })
    ];
    const plan = pickMovableChildren(kids, 'p', 'done');
    assert.deepEqual(plan.map(k => k.id), ['a']);
    // a 已是 in_review —— 与目标相同的不动。
    assert.deepEqual(pickMovableChildren(kids, 'p', 'in_review').map(k => k.id), ['b', 'c']);
  });
});

describe('moveWithRetry', () => {
  const api = (failFirstWith?: ApiError) => {
    const calls: Array<{ id: string; version: number }> = [];
    let shown = 0;
    return {
      calls: calls as ReadonlyArray<{ id: string; version: number }>,
      shownCount: () => shown,
      updateIssue: async (id: string, body: { status: string; version: number }) => {
        calls.push({ id, version: body.version });
        if (failFirstWith && calls.length === 1) throw failFirstWith;
      },
      showIssue: async () => { shown++; return { version: 99 }; }
    };
  };

  it('succeeds on the first try — no reread', async () => {
    const a = api();
    await moveWithRetry(a, 'x', 'done', 3);
    assert.deepEqual(a.calls, [{ id: 'x', version: 3 }]);
    assert.equal(a.shownCount(), 0);
  });

  it('on 409 rereads the server version and retries once', async () => {
    const a = api(new ApiError('version conflict', 409));
    await moveWithRetry(a, 'x', 'done', 3);
    assert.deepEqual(a.calls, [{ id: 'x', version: 3 }, { id: 'x', version: 99 }]);
    assert.equal(a.shownCount(), 1);
  });

  it('non-409 errors propagate without a retry', async () => {
    const a = api(new ApiError('nope', 500));
    await assert.rejects(moveWithRetry(a, 'x', 'done', 3), /nope/);
    assert.equal(a.calls.length, 1);
    assert.equal(a.shownCount(), 0);
  });

  it('a 409 whose retry also fails surfaces the second error', async () => {
    let n = 0;
    const stubborn = {
      updateIssue: async () => { n++; throw n === 1 ? new ApiError('conflict', 409) : new ApiError('gone', 404); },
      showIssue: async () => ({ version: 42 })
    };
    await assert.rejects(moveWithRetry(stubborn, 'x', 'done', 1), /gone/);
    assert.equal(n, 2);
  });
});

describe('issueMatchesFilters', () => {
  const today = '2026-10-17';
  const base = mk({ id: 'i', title: '搭建登录模块', description: 'JWT 鉴权' });

  it('matches text against title or description, case-insensitive', () => {
    assert.equal(issueMatchesFilters(base, { text: '登录', assignee: '', label: '', due: '' }, today), true);
    assert.equal(issueMatchesFilters(base, { text: 'jwt', assignee: '', label: '', due: '' }, today), true);
    assert.equal(issueMatchesFilters(base, { text: '支付', assignee: '', label: '', due: '' }, today), false);
  });

  it('matches assignee, label (comma-tolerant), and their combination', () => {
    const i = mk({ id: 'i', title: 't', assignee: 'alice', labels: 'frontend, backend' });
    assert.equal(issueMatchesFilters(i, { text: '', assignee: 'alice', label: '', due: '' }, today), true);
    assert.equal(issueMatchesFilters(i, { text: '', assignee: 'bob', label: '', due: '' }, today), false);
    assert.equal(issueMatchesFilters(i, { text: '', assignee: '', label: 'backend', due: '' }, today), true);
    assert.equal(issueMatchesFilters(i, { text: '', assignee: 'alice', label: 'backend', due: '' }, today), true);
    assert.equal(issueMatchesFilters(i, { text: '', assignee: 'bob', label: 'backend', due: '' }, today), false);
  });

  it('due chip: overdue strictly before today, today exact, null never matches', () => {
    const overdue = mk({ id: 'i', title: 't', dueDate: '2026-10-16' });
    const dueToday = mk({ id: 'i', title: 't', dueDate: '2026-10-17' });
    const future = mk({ id: 'i', title: 't', dueDate: '2026-10-18' });
    const none = mk({ id: 'i', title: 't' });
    assert.equal(issueMatchesFilters(overdue, { text: '', assignee: '', label: '', due: 'overdue' }, today), true);
    assert.equal(issueMatchesFilters(dueToday, { text: '', assignee: '', label: '', due: 'overdue' }, today), false);
    assert.equal(issueMatchesFilters(dueToday, { text: '', assignee: '', label: '', due: 'today' }, today), true);
    assert.equal(issueMatchesFilters(future, { text: '', assignee: '', label: '', due: 'today' }, today), false);
    assert.equal(issueMatchesFilters(none, { text: '', assignee: '', label: '', due: 'overdue' }, today), false);
  });
});

describe('buildLanes / flattenCardOrder / todayStr', () => {
  it("'none' yields a single anonymous lane", () => {
    const lanes = buildLanes([mk({ id: 'a', title: 'a' })], 'none');
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0]!.title, '');
  });

  it('assignee lanes keep children with their parent; unassigned falls back last', () => {
    const issues = [
      mk({ id: 'kid', title: 'kid', parentId: 'p1' }),
      mk({ id: 'p1', title: 'p1', assignee: 'alice' }),
      mk({ id: 'p2', title: 'p2' })
    ];
    const lanes = buildLanes(issues, 'assignee');
    assert.deepEqual(lanes.map(l => l.title), ['alice', '未分配']);
    assert.deepEqual(lanes[0]!.issues.map(i => i.id), ['p1', 'kid']);
  });

  it('label lanes duplicate multi-label parents across lanes', () => {
    const issues = [mk({ id: 'p', title: 'p', labels: 'a,b' })];
    const lanes = buildLanes(issues, 'label');
    assert.deepEqual(lanes.map(l => l.title), ['a', 'b']);
    assert.equal(lanes[0]!.issues.length, 1);
    assert.equal(lanes[1]!.issues.length, 1);
  });

  it('flattenCardOrder orders by status column, children nested after their parent', () => {
    const issues = [
      mk({ id: 'kid', title: 'kid', parentId: 'pA', status: 'in_review' }),
      mk({ id: 'pA', title: 'pA', status: 'in_progress' }),
      mk({ id: 'pB', title: 'pB', status: 'todo' })
    ];
    assert.deepEqual(flattenCardOrder(issues, 'none'), ['pB', 'pA', 'kid']);
  });

  it('todayStr renders local-date YYYY-MM-DD', () => {
    assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('fmtWhenLocal / fmtHMLocal（时间本地化）', () => {
  it('converts UTC ISO to local MM-DD HH:mm', async () => {
    const { fmtWhenLocal } = await import('../src/logic/time.js');
    // 2026-10-18T01:53:00Z → 本地时区渲染（这里用本地偏移反推期望值）
    const iso = '2026-10-18T01:53:00.000Z';
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    assert.equal(fmtWhenLocal(iso), expected);
  });

  it('fmtHMLocal renders local HH:mm', async () => {
    const { fmtHMLocal } = await import('../src/logic/time.js');
    const iso = '2026-10-18T01:53:00.000Z';
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    assert.equal(fmtHMLocal(iso), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  });

  it('returns the input unchanged for invalid iso', async () => {
    const { fmtWhenLocal, fmtHMLocal } = await import('../src/logic/time.js');
    assert.equal(fmtWhenLocal('垃圾'), '垃圾');
    assert.equal(fmtHMLocal(''), '');
  });
});
