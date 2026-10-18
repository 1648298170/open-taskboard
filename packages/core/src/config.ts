// Single source for TASKBOARD_* environment resolution, both server-side and
// client-side. Every fallback chain lives here exactly once — spread copies
// of `env ?? default` across server/cli/mcp is how the DATA_DIR/HOST/PORT
// drift bugs happened. Semantics: an empty string counts as unset, ports
// must be positive integers (anything else falls back to the default), the
// feature flags are strict '1', and TASKBOARD_URL outranks TASKBOARD_PORT.
// Both resolvers take an injectable env — callers pass process.env, tests
// pass a plain object.

export type TaskboardEnv = Record<string, string | undefined>;

export interface TaskboardServerConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Empty string = no auth (TASKBOARD_TOKEN unset). */
  token: string;
  readonly: boolean;
  humanDone: boolean;
  reviewComment: boolean;
  backupsEnabled: boolean;
  webhookUrls: string[];
  /** Empty string = unsigned webhooks (TASKBOARD_WEBHOOK_SECRET unset). */
  webhookSecret: string;
}

export interface TaskboardClientConfig {
  baseUrl: string;
  token: string;
  /** TASKBOARD_NO_AUTOSTART=1: MCP must fail loudly instead of spawning a local shadow server. */
  noAutostart: boolean;
}

const DEFAULT_PORT = 47824;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DATA_DIR = '.data';

const parsePort = (raw: string | undefined): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
};

export function resolveServerConfig(env: TaskboardEnv = process.env): TaskboardServerConfig {
  return {
    host: env.TASKBOARD_HOST || DEFAULT_HOST,
    port: parsePort(env.TASKBOARD_PORT),
    dataDir: env.TASKBOARD_DATA_DIR || DEFAULT_DATA_DIR,
    token: env.TASKBOARD_TOKEN || '',
    readonly: env.TASKBOARD_READONLY === '1',
    // 默认开启：docs 承诺「done 必须等用户确认」，默认行为必须与之一致；
    // 纯自动化看板用 TASKBOARD_HUMAN_DONE=0 显式关闭（opt-out）。
    humanDone: env.TASKBOARD_HUMAN_DONE !== '0',
    // 默认开启：docs 承诺「in_review 需附验证评论」，默认行为与之一致；
    // 纯自动化看板用 TASKBOARD_REVIEW_COMMENT=0 显式关闭。
    reviewComment: env.TASKBOARD_REVIEW_COMMENT !== '0',
    backupsEnabled: env.TASKBOARD_BACKUPS !== '0',
    webhookSecret: env.TASKBOARD_WEBHOOK_SECRET || '',
    webhookUrls: (env.TASKBOARD_WEBHOOK_URL ?? '').split(',').map(url => url.trim()).filter(url => url.length > 0)
  };
}

export function resolveClientConfig(env: TaskboardEnv = process.env): TaskboardClientConfig {
  const token = env.TASKBOARD_TOKEN || '';
  const url = env.TASKBOARD_URL || '';
  const baseUrl = url || `http://${DEFAULT_HOST}:${parsePort(env.TASKBOARD_PORT)}`;
  return { baseUrl, token, noAutostart: env.TASKBOARD_NO_AUTOSTART === '1' };
}
