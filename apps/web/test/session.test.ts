// 项目级 OpenCode 会话纯逻辑单测：初始选中项、选中会话回填项目名/工作区、
// 默认会话缺失时的合成选项。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpenCodeSessionOption } from '../src/api';
import {
  MISSING_DEFAULT_SESSION_LABEL, initialSessionId, mergeSessionOptions, sessionProjectName, sessionWorkspacePath
} from '../src/logic/session';

const session = (id: string, title = id): OpenCodeSessionOption => ({
  id, title, directory: '', updatedAt: null
});

describe('initialSessionId', () => {
  it('uses the project default when non-empty, otherwise an empty string', () => {
    assert.equal(initialSessionId('ses_123'), 'ses_123');
    assert.equal(initialSessionId(''), '');
    assert.equal(initialSessionId(undefined), '');
    assert.equal(initialSessionId('  ses_123  '), 'ses_123');
  });
});

describe('sessionProjectName', () => {
  it('returns the trimmed session title', () => {
    assert.equal(sessionProjectName({ ...session('a'), title: '  Fix login  ' }), 'Fix login');
  });

  it('returns an empty string when the title or session is missing', () => {
    assert.equal(sessionProjectName(undefined), '');
    assert.equal(sessionProjectName({ ...session('a'), title: '' }), '');
    assert.equal(sessionProjectName({ ...session('a'), title: '   ' }), '');
  });
});

describe('sessionWorkspacePath', () => {
  it('returns a trimmed directory for a real session', () => {
    assert.equal(sessionWorkspacePath({ ...session('a'), directory: '  D:\\work\\app  ' }), 'D:\\work\\app');
  });

  it('returns an empty string for an undefined session', () => {
    assert.equal(sessionWorkspacePath(undefined), '');
  });

  it('returns an empty string for empty or synthetic directories', () => {
    assert.equal(sessionWorkspacePath({ ...session('a'), directory: '' }), '');
    assert.equal(sessionWorkspacePath({ ...session('a'), directory: '   ' }), '');
    const synthetic = mergeSessionOptions([], 'gone').options[0]!;
    assert.equal(sessionWorkspacePath(synthetic), '');
  });
});

describe('mergeSessionOptions', () => {
  const live = [session('a'), session('b')];

  it('does not add a synthetic option when the default is present', () => {
    const result = mergeSessionOptions(live, 'b');
    assert.deepEqual(result.options.map(o => o.id), ['a', 'b']);
    assert.equal(result.missingDefault, false);
  });

  it('appends and selects a synthetic option when the default is missing', () => {
    const result = mergeSessionOptions(live, 'gone');
    assert.deepEqual(result.options.map(o => o.id), ['a', 'b', 'gone']);
    const synthetic = result.options[result.options.length - 1]!;
    assert.equal(synthetic.title, MISSING_DEFAULT_SESSION_LABEL);
    assert.equal(synthetic.directory, '');
    assert.equal(synthetic.updatedAt, null);
    // 初始选中仍指向默认会话（合成选项保证 Select 能显示它）。
    assert.equal(initialSessionId('gone'), 'gone');
    assert.equal(result.missingDefault, true);
  });

  it('keeps the list untouched when there is no default', () => {
    const result = mergeSessionOptions(live, '');
    assert.deepEqual(result.options.map(o => o.id), ['a', 'b']);
    assert.equal(result.missingDefault, false);
  });
});
