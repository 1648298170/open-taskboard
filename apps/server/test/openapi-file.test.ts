// 契约一致性：落盘的 apps/server/openapi.json 必须与源 openApiSpec 严格一致。
// 防止「改了 spec 忘了重建」的漂移（v8 意见 6）。重建命令：pnpm --filter @taskboard/server openapi
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openApiSpec } from '../src/openapi-spec.js';

describe('openapi file sync', () => {
  it('committed apps/server/openapi.json deep-equals openApiSpec', () => {
    const file = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    assert.deepEqual(file, JSON.parse(JSON.stringify(openApiSpec)));
  });
});
