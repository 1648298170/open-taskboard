// Command registry: name → Command strategy. The entry (cli.ts) looks up here
// and calls run(ctx) with an injected context — commands never import ../http.js.
import type { Flags } from '../flags.js';
import { projectCommands } from './project.js';
import { issueCommands } from './issue.js';
import { commentCommands } from './comment.js';
import { progressCommand } from './progress.js';
import { statsCommand } from './stats.js';
import { nextCommand, readyCommand } from './pickup.js';
import { searchCommand } from './search.js';
import { serveCommand } from './serve.js';
import { exportCommand } from './export.js';
import { templatesCommand } from './templates.js';

/** Same signature as `api()` from ../http.js, injected via CommandContext. */
export type ApiClient = (method: string, path: string, body?: unknown) => Promise<any>;

export interface CommandContext {
  api: ApiClient;
  base: () => string;
  flags: Flags;
  rest: string[];
}

export interface Command {
  summary: string;
  usage?: string;
  /** Dispatch on the bare command word and ignore any sub word (`taskboard serve X` still serves). */
  bare?: boolean;
  run(ctx: CommandContext): Promise<void>;
}

/** Print `usage: …` to stderr and exit 1 when a precondition fails. */
export const need = (cond: boolean, usage: string): void => {
  if (!cond) { console.error(`usage: ${usage}`); process.exit(1); }
};

/** Path segment encoder — ids come from user args, never trust them raw in URLs. */
export const seg = (value: unknown): string => encodeURIComponent(String(value));

export const registry: Record<string, Command> = {
  ...projectCommands,
  ...issueCommands,
  ...commentCommands,
  progress: progressCommand,
  stats: statsCommand,
  next: nextCommand,
  ready: readyCommand,
  search: searchCommand,
  serve: serveCommand,
  export: exportCommand,
  templates: templatesCommand
};
