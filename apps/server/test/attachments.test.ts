// Attachment endpoints: multipart needs a real socket (fetch + FormData),
// so these tests listen on an ephemeral port instead of using inject.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { Store } from '@taskboard/core';
import type { FastifyInstance } from 'fastify';

async function listenApp(): Promise<{ base: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'tb-attach-test-'));
  const store = new Store(dir, new DatabaseSync(':memory:'));
  const { app } = await buildApp({ store, env: {} });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    base,
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

const H = { 'content-type': 'application/json' };

async function seedIssue(base: string): Promise<string> {
  await fetch(`${base}/api/projects`, { method: 'POST', headers: H, body: JSON.stringify({ id: 'p1', name: 'P' }) });
  const res = await fetch(`${base}/api/projects/p1/issues`, {
    method: 'POST', headers: H, body: JSON.stringify({ title: 'A' })
  });
  return (await res.json() as { id: string }).id;
}

describe('attachment endpoints', () => {
  it('uploads, lists and downloads a file', async () => {
    const { base, close } = await listenApp();
    try {
      const issueId = await seedIssue(base);
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('hello attachment body')]), 'hello.txt');
      const up = await fetch(`${base}/api/issues/${issueId}/attachments`, { method: 'POST', body: form });
      assert.equal(up.status, 201);
      const meta = await up.json() as { id: string; filename: string; size: number };
      assert.equal(meta.filename, 'hello.txt');
      assert.equal(meta.size, 'hello attachment body'.length);

      const list = await fetch(`${base}/api/issues/${issueId}/attachments`);
      assert.equal((await list.json() as unknown[]).length, 1);

      const dl = await fetch(`${base}/api/attachments/${meta.id}/download`);
      assert.equal(dl.status, 200);
      assert.equal(await dl.text(), 'hello attachment body');
      assert.match(dl.headers.get('content-disposition') ?? '', /hello\.txt/);
    } finally { await close(); }
  });

  it('rejects non-multipart bodies and empty files with 400', async () => {
    const { base, close } = await listenApp();
    try {
      const issueId = await seedIssue(base);
      const notMultipart = await fetch(`${base}/api/issues/${issueId}/attachments`, {
        method: 'POST', headers: H, body: JSON.stringify({ nope: true })
      });
      assert.equal(notMultipart.status, 400);

      const empty = new FormData();
      empty.append('file', new Blob([]), 'empty.txt');
      const res = await fetch(`${base}/api/issues/${issueId}/attachments`, { method: 'POST', body: empty });
      assert.equal(res.status, 400);
    } finally { await close(); }
  });

  it('404s the download of an unknown attachment id', async () => {
    const { base, close } = await listenApp();
    try {
      const res = await fetch(`${base}/api/attachments/ghost/download`);
      assert.equal(res.status, 404);
    } finally { await close(); }
  });

  it('deletes an attachment: 200 {ok:true}, list/detail drop it, second delete 404', async () => {
    const { base, close } = await listenApp();
    try {
      const issueId = await seedIssue(base);
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('to be deleted')]), 'delete-me.txt');
      const up = await fetch(`${base}/api/issues/${issueId}/attachments`, { method: 'POST', body: form });
      const meta = await up.json() as { id: string };

      const del = await fetch(`${base}/api/attachments/${meta.id}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.deepEqual(await del.json(), { ok: true });

      const list = await fetch(`${base}/api/issues/${issueId}/attachments`);
      assert.deepEqual(await list.json(), []);
      assert.equal((await fetch(`${base}/api/attachments/${meta.id}/download`)).status, 404);

      const again = await fetch(`${base}/api/attachments/${meta.id}`, { method: 'DELETE' });
      assert.equal(again.status, 404);
    } finally { await close(); }
  });

  it('rejects uploads for a missing issue with 404', async () => {
    const { base, close } = await listenApp();
    try {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('x')]), 'x.txt');
      const res = await fetch(`${base}/api/issues/ghost/attachments`, { method: 'POST', body: form });
      assert.equal(res.status, 404);
    } finally { await close(); }
  });
});
