// cli 命令编排层测试：ctx.api 注入 mock，断言 body 构造 / 调用顺序 /
// 冲突分支。console 与 process.exit 打桩（import 失败路径会 exit(1)）。
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// registry 必须最先加载：它 spread 各命令表（issue.js 等），entry 若先 import
// 命令模块会触发 TDZ 环（watch.ts 头注释记载的同款坑，cli.ts 同序规避）。
import { need } from '../src/commands/registry.js';
import { issueCommands } from '../src/commands/issue.js';
import { backupCommand } from '../src/commands/backup.js';
import { importCommand } from '../src/commands/import.js';
import type { ApiClient, CommandContext, Flags } from '../src/commands/registry.js';

void need;

interface Call { method: string; path: string; body?: unknown }

const makeCtx = (flags: Flags = {}, rest: string[] = []) => {
  const calls: Call[] = [];
  const ctx: CommandContext = {
    api: (async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { id: 'new1', path: '/data/backups/snap-0001.db' };
    }) as unknown as ApiClient,
    base: () => 'http://t',
    token: () => '',
    flags,
    rest
  };
  return { calls, ctx };
};

const quiet = async (fn: () => Promise<void>): Promise<{ logs: string[]; errs: string[] }> => {
  const logs: string[] = [];
  const errs: string[] = [];
  const log = console.log, err = console.error, exit = process.exit;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  process.exit = ((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as typeof process.exit;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
    process.exit = exit;
  }
  return { logs, errs };
};

describe('issue claim body construction', () => {
  it('carries --ttl and --session-id into the claim body', async () => {
    const { calls, ctx } = makeCtx({ agent: 'sisyphus', ttl: '45', 'session-id': 'ses_x' }, ['ISSUE1']);
    await quiet(() => issueCommands['issue claim']!.run(ctx));
    assert.deepEqual(calls, [{
      method: 'POST',
      path: '/api/issues/ISSUE1/claim',
      body: { agent: 'sisyphus', ttlMinutes: 45, sessionId: 'ses_x' }
    }]);
  });

  it('omits absent flags (agent-only body)', async () => {
    const { calls, ctx } = makeCtx({ agent: 'a' }, ['I2']);
    await quiet(() => issueCommands['issue claim']!.run(ctx));
    assert.deepEqual(calls[0]!.body, { agent: 'a' });
  });
});

describe('backup', () => {
  it('POSTs /api/backup and prints the snapshot path', async () => {
    const { calls, ctx } = makeCtx();
    const { logs } = await quiet(() => backupCommand.run(ctx));
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/backup', body: {} }]);
    assert.equal(logs[0], 'backup: /data/backups/snap-0001.db');
  });
});

describe('import', () => {
  const payload = {
    projects: [{
      id: 'src', name: 'Src',
      issues: [
        { id: 'i1', title: 'A' },
        { id: 'i2', title: 'B', parentId: 'i1', labels: 'x' },
        { id: 'i3', title: 'C', comments: [{ author: 'a', body: 'hello' }] }
      ],
      dependencies: [{ issueId: 'i2', dependsOnId: 'i1' }]
    }]
  };

  const makeFixture = (): { dir: string; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-cli-test-'));
    const file = join(dir, 'export.json');
    writeFileSync(file, JSON.stringify(payload));
    return { dir, file };
  };

  it('--dry-run inspects without a single write call', async () => {
    const { dir, file } = makeFixture();
    const { calls, ctx } = makeCtx({ 'dry-run': true }, [file]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 404 })) as typeof fetch;
    try {
      const { logs } = await quiet(() => importCommand.run(ctx));
      assert.deepEqual(calls, [], 'dry-run must not write');
      assert.match(logs.join('\n'), /\[dry-run\] project src: 3 issues, 1 comments, 1 dependencies/);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('real import recreates project → issues (tops first, id rewrite) → comments → deps', async () => {
    const { dir, file } = makeFixture();
    const { calls, ctx } = makeCtx({}, [file]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 404 })) as typeof fetch;
    try {
      const { logs } = await quiet(() => importCommand.run(ctx));
      const paths = calls.map(c => `${c.method} ${c.path}`);
      // tops 先行（i1, i3），kids 随后（i2）；mock 对所有创建返回同一 id new1，
      // 故 i3 的评论与依赖路径同为 /api/issues/new1/*。
      assert.deepEqual(paths, [
        'POST /api/projects',
        'POST /api/projects/src/issues',
        'POST /api/projects/src/issues',
        'POST /api/issues/new1/comments',
        'POST /api/projects/src/issues',
        'POST /api/issues/new1/dependencies'
      ]);
      // id rewrite: child i2's parentId maps to the NEW id of i1 (new1)
      const child = calls[4]!.body as { title: string; parentId: string };
      assert.equal(child.title, 'B');
      assert.equal(child.parentId, 'new1');
      assert.match(logs.join('\n'), /imported src: 3 issues, 1 comments, 1 dependencies/);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a conflicting project id rejects the import with exit 1 and zero writes', async () => {
    const { dir, file } = makeFixture();
    const { calls, ctx } = makeCtx({}, [file]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    try {
      const { errs } = await quiet(() => importCommand.run(ctx));
      assert.match(errs.join('\n'), /already exists on this board/);
      assert.deepEqual(calls, []);
    } catch (err) {
      assert.match((err as Error).message, /exit:1/);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
