// 项目级 OpenCode 会话选择纯逻辑：初始选中项、选中会话回填的项目名/工作区、
// 默认会话不在实时列表时补合成选项（避免静默丢失绑定）。
import type { OpenCodeSessionOption } from '../api';

/** 合成选项文案：项目默认会话未出现在实时列表里时使用。 */
export const MISSING_DEFAULT_SESSION_LABEL = '项目默认会话（当前列表未返回）';

/** 初始会话：有项目默认会话就用默认，否则留空（仍需人工选择）。 */
export function initialSessionId(defaultSessionId?: string | null): string {
  return (defaultSessionId ?? '').trim();
}

/** 选中会话标题作为项目名（自动回填用）；无标题 → 空串，调用方据此跳过回填。 */
export function sessionProjectName(session: OpenCodeSessionOption | undefined): string {
  return session?.title.trim() ?? '';
}

/**
 * 选中会话对应的项目工作区路径（自动回填用）。
 * 合成选项 / 未提供目录 → 空串，调用方据此决定是否回填。
 */
export function sessionWorkspacePath(session: OpenCodeSessionOption | undefined): string {
  return session?.directory.trim() ?? '';
}

export interface SessionChoices {
  options: OpenCodeSessionOption[];
  /** true = 默认会话不在实时列表，已用合成选项兜底。 */
  missingDefault: boolean;
}

/**
 * 合并实时会话列表与项目默认会话。
 * 默认会话存在或为空时原样返回；缺失时追加一个合成选项，
 * 保证 Select 仍能显示并保留该默认值。
 */
export function mergeSessionOptions(
  sessions: OpenCodeSessionOption[],
  defaultSessionId?: string | null
): SessionChoices {
  const def = (defaultSessionId ?? '').trim();
  if (!def || sessions.some(session => session.id === def)) {
    return { options: sessions, missingDefault: false };
  }
  return {
    options: [
      ...sessions,
      { id: def, title: MISSING_DEFAULT_SESSION_LABEL, directory: '', updatedAt: null }
    ],
    missingDefault: true
  };
}
