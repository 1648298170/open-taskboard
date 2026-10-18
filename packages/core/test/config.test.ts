// Taskboard env resolution (packages/core/src/config.ts).
//
// pins the single fallback chain for every TASKBOARD_* variable: empty
// strings count as unset, ports must be positive integers, flags are strict
// '1', and TASKBOARD_URL outranks TASKBOARD_PORT on the client side.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerConfig, resolveClientConfig } from '../src/config.js';

describe('resolveServerConfig', () => {
  it('falls back to defaults on an empty env', () => {
    assert.deepEqual(resolveServerConfig({}), {
      host: '127.0.0.1',
      port: 47824,
      dataDir: '.data',
      token: '',
      readonly: false,
      humanDone: true,
      reviewComment: true,
      requireSession: true,
      backupsEnabled: true,
      webhookUrls: [],
      webhookSecret: ''
    });
  });

  it('overrides host/port/dataDir from env', () => {
    const cfg = resolveServerConfig({ TASKBOARD_HOST: '0.0.0.0', TASKBOARD_PORT: '5000', TASKBOARD_DATA_DIR: '/tmp/x' });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 5000);
    assert.equal(cfg.dataDir, '/tmp/x');
  });

  it('treats empty-string values as unset (blank env must not yield blank config)', () => {
    const cfg = resolveServerConfig({ TASKBOARD_HOST: '', TASKBOARD_PORT: '', TASKBOARD_DATA_DIR: '' });
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 47824);
    assert.equal(cfg.dataDir, '.data');
  });

  it('falls back to the default port on non-integer or non-positive ports', () => {
    assert.equal(resolveServerConfig({ TASKBOARD_PORT: 'abc' }).port, 47824);
    assert.equal(resolveServerConfig({ TASKBOARD_PORT: '-3' }).port, 47824);
    assert.equal(resolveServerConfig({ TASKBOARD_PORT: '47824.5' }).port, 47824);
  });

  it('parses feature flags strictly as "1"; TASKBOARD_BACKUPS=0 disables backups', () => {
    const on = resolveServerConfig({ TASKBOARD_READONLY: '1', TASKBOARD_HUMAN_DONE: '1' });
    assert.equal(on.readonly, true);
    assert.equal(on.humanDone, true);
    // humanDone 默认开（opt-out 语义）：任何非 '0' 值（含未设置）都启用。
    const yes = resolveServerConfig({ TASKBOARD_READONLY: 'true', TASKBOARD_HUMAN_DONE: 'yes', TASKBOARD_BACKUPS: '0' });
    assert.equal(yes.readonly, false);
    assert.equal(yes.humanDone, true);
    assert.equal(yes.backupsEnabled, false);
  });

  it('humanDone opts out only via TASKBOARD_HUMAN_DONE=0', () => {
    assert.equal(resolveServerConfig({ TASKBOARD_HUMAN_DONE: '0' }).humanDone, false);
  });

  it('reviewComment defaults on; opts out only via TASKBOARD_REVIEW_COMMENT=0', () => {
    assert.equal(resolveServerConfig({}).reviewComment, true);
    assert.equal(resolveServerConfig({ TASKBOARD_REVIEW_COMMENT: 'yes' }).reviewComment, true);
    assert.equal(resolveServerConfig({ TASKBOARD_REVIEW_COMMENT: '0' }).reviewComment, false);
  });

  it('splits, trims and drops empty webhook urls', () => {
    const cfg = resolveServerConfig({ TASKBOARD_WEBHOOK_URL: ' http://a/x , http://b/y ,,' });
    assert.deepEqual(cfg.webhookUrls, ['http://a/x', 'http://b/y']);
  });

  it('exposes the webhook secret verbatim (empty when unset)', () => {
    assert.equal(resolveServerConfig({ TASKBOARD_WEBHOOK_SECRET: 's3cr3t' }).webhookSecret, 's3cr3t');
    assert.equal(resolveServerConfig({}).webhookSecret, '');
  });

  it('exposes the token verbatim (empty when unset)', () => {
    assert.equal(resolveServerConfig({ TASKBOARD_TOKEN: 'sekret' }).token, 'sekret');
    assert.equal(resolveServerConfig({}).token, '');
  });
});

describe('resolveClientConfig', () => {
  it('defaults to http://127.0.0.1:47824 with no token and autostart on', () => {
    assert.deepEqual(resolveClientConfig({}), {
      baseUrl: 'http://127.0.0.1:47824',
      token: '',
      noAutostart: false
    });
  });

  it('TASKBOARD_URL wins over TASKBOARD_PORT', () => {
    const cfg = resolveClientConfig({ TASKBOARD_URL: 'http://box:1', TASKBOARD_PORT: '5000' });
    assert.equal(cfg.baseUrl, 'http://box:1');
  });

  it('derives the base url from TASKBOARD_PORT when URL is absent', () => {
    assert.equal(resolveClientConfig({ TASKBOARD_PORT: '5000' }).baseUrl, 'http://127.0.0.1:5000');
  });

  it('ignores a blank TASKBOARD_URL and a bad port', () => {
    const cfg = resolveClientConfig({ TASKBOARD_URL: '', TASKBOARD_PORT: 'x' });
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:47824');
  });

  it('carries the token', () => {
    assert.equal(resolveClientConfig({ TASKBOARD_TOKEN: 't' }).token, 't');
  });

  it('parses TASKBOARD_NO_AUTOSTART strictly as "1" (guards MCP against zombie local spawns)', () => {
    assert.equal(resolveClientConfig({ TASKBOARD_NO_AUTOSTART: '1' }).noAutostart, true);
    assert.equal(resolveClientConfig({ TASKBOARD_NO_AUTOSTART: 'true' }).noAutostart, false);
    assert.equal(resolveClientConfig({}).noAutostart, false);
  });
});
