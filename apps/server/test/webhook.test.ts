// Webhook delivery (T6-34) + HMAC signing (v0.4 P1). A local receiver on an
// ephemeral port captures what the server fans out; the signed variant must
// carry X-Taskboard-Signature: sha256=HMAC(body, secret) over the exact raw
// bytes, and an unsigned config must send no signature header at all.

import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { Store } from '@taskboard/core';
import type { FastifyInstance } from 'fastify';

interface Captured { body: string; headers: IncomingMessage['headers'] }

async function startReceiver(): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = [];
  let resolveFirst: (() => void) | null = null;
  const first = new Promise<void>(r => { resolveFirst = r; });
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      captured.push({ body, headers: req.headers });
      res.writeHead(200).end();
      resolveFirst?.();
      resolveFirst = null;
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    captured,
    close: async () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

async function triggerEventAndAwait(app: FastifyInstance, captured: Captured[]): Promise<Captured> {
  const posted = app.inject({
    method: 'POST', url: '/api/projects',
    headers: { 'content-type': 'application/json' }, payload: { name: 'webhook-test' }
  }).then(r => { if (r.statusCode !== 201) throw new Error(`trigger failed: ${r.statusCode}`); });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('webhook not delivered in 3s')), 3000));
  const delivered = new Promise<Captured>(resolve => {
    const check = (): void => {
      const last = captured[captured.length - 1];
      if (last) resolve(last); else setTimeout(check, 25);
    };
    check();
  });
  const result = await Promise.race([delivered, timeout]);
  await posted;
  return result;
}

describe('webhook delivery', () => {
  it('signs the body with HMAC-SHA256 when TASKBOARD_WEBHOOK_SECRET is set', async () => {
    const receiver = await startReceiver();
    const dir = mkdtempSync(join(tmpdir(), 'tb-hook-test-'));
    const store = new Store(dir, new DatabaseSync(':memory:'));
    const { app } = await buildApp({
      store,
      env: { TASKBOARD_WEBHOOK_URL: receiver.url, TASKBOARD_WEBHOOK_SECRET: 's3cr3t' }
    });
    try {
      const captured = await triggerEventAndAwait(app, receiver.captured);
      const event = JSON.parse(captured.body) as { type: string };
      assert.equal(event.type, 'project.created');
      const expected = 'sha256=' + createHmac('sha256', 's3cr3t').update(captured.body).digest('hex');
      assert.equal(captured.headers['x-taskboard-signature'], expected);
    } finally {
      await app.close();
      await receiver.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends no signature header when the secret is unset', async () => {
    const receiver = await startReceiver();
    const dir = mkdtempSync(join(tmpdir(), 'tb-hook-test-'));
    const store = new Store(dir, new DatabaseSync(':memory:'));
    const { app } = await buildApp({ store, env: { TASKBOARD_WEBHOOK_URL: receiver.url } });
    try {
      const captured = await triggerEventAndAwait(app, receiver.captured);
      assert.equal(JSON.parse(captured.body).type, 'project.created');
      assert.equal(captured.headers['x-taskboard-signature'], undefined);
    } finally {
      await app.close();
      await receiver.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
