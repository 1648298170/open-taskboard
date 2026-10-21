// `taskboard setup` — register/unregister OS-level autostart for the two
// long-running sidecars (taskboard watch + opencode serve), plus the two
// targeted stop helpers. All platform logic lives in ../autostart/*; this file
// only parses flags, resolves runtime paths, and prints user-facing output.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOpencodeCommand, selectStrategy } from '../autostart/index.js';
import {
  assertSupportedNode,
  type AutostartAgent,
  type AutostartDeps,
  type ExecFn,
  type ExecResult,
  type SetupConfig
} from '../autostart/types.js';
import type { Flags } from '../flags.js';
import type { Command } from './registry.js';

export interface SetupOptions {
  opencodeUrl?: string;
  boardUrl?: string;
  unregister?: boolean;
  print?: boolean;
}

const stringFlag = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

export function optionsFromFlags(flags: Flags): SetupOptions {
  const options: SetupOptions = {};
  const opencodeUrl = stringFlag(flags['opencode-url']);
  if (opencodeUrl !== undefined) options.opencodeUrl = opencodeUrl;
  const boardUrl = stringFlag(flags['board-url']);
  if (boardUrl !== undefined) options.boardUrl = boardUrl;
  if (flags.unregister === true) options.unregister = true;
  if (flags.print === true) options.print = true;
  return options;
}

/**
 * Resolve the checkout from the running CLI file, not from cwd: users often
 * invoke `taskboard` from a project directory, and the generated autostart
 * files must keep pointing at the checkout that installed the command.
 * Walking up to `apps/cli/package.json` works identically from
 * apps/cli/src/commands (tsx) and apps/cli/dist/commands (built output).
 */
function resolveRepoRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let candidate = start;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(path.join(candidate, 'apps', 'cli', 'package.json'))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (existsSync(path.join(process.cwd(), 'apps', 'cli', 'package.json'))) return process.cwd();
  return process.cwd();
}

const defaultExec: ExecFn = (command, args) => new Promise<ExecResult>(resolve => {
  execFile(command, [...args], { windowsHide: true }, (error, stdout, stderr) => {
    let code = 0;
    if (error !== null) {
      const raw = (error as NodeJS.ErrnoException).code;
      code = typeof raw === 'number' ? raw : 1;
    }
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/**
 * process.execPath is authoritative, but fnm/pnpm may expose it through a
 * per-shell shim (fnm_multishells/<id>/node.exe). Realpath collapses that to
 * the installed binary so the generated launcher survives a reboot.
 */
function canonicalExecPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

export function defaultDeps(): AutostartDeps {
  return {
    writeFile: (file, content) => { writeFileSync(file, content, 'utf8'); },
    mkdir: dir => { mkdirSync(dir, { recursive: true }); },
    deleteFile: file => {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    exec: defaultExec,
    homedir: () => homedir(),
    platform: process.platform,
    nodeExecPath: canonicalExecPath(),
    nodeVersion: process.versions.node,
    repoRoot: resolveRepoRoot(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    env: process.env,
    now: () => new Date()
  };
}

function normalizeUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`setup: invalid ${label} "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`setup: ${label} must use http or https (got "${raw}")`);
  }
  return raw.trim().replace(/\/+$/, '');
}

async function resolveConfig(options: SetupOptions, deps: AutostartDeps): Promise<SetupConfig> {
  const boardUrl = normalizeUrl(
    options.boardUrl ?? deps.env.TASKBOARD_URL ?? 'http://127.0.0.1:47824',
    'board URL'
  );
  const opencodeUrl = normalizeUrl(
    options.opencodeUrl ?? deps.env.TASKBOARD_OPENCODE_URL ?? 'http://127.0.0.1:4096',
    'opencode URL'
  );
  const parsed = new URL(opencodeUrl);
  const opencodePort = parsed.port === '' ? 4096 : Number(parsed.port);
  if (!Number.isInteger(opencodePort) || opencodePort < 1 || opencodePort > 65535) {
    throw new Error(`setup: invalid opencode port in "${opencodeUrl}"`);
  }
  const platformPath = deps.platform === 'darwin' ? path.posix : path.win32;
  return {
    boardUrl,
    opencodeUrl,
    opencodePort,
    opencodeCommand: await resolveOpencodeCommand(deps),
    repoRoot: platformPath.resolve(deps.repoRoot),
    nodeExecPath: platformPath.resolve(deps.nodeExecPath)
  };
}

/**
 * Testable core: the command wrapper only supplies defaultDeps(). Keeping the
 * dependency object as a parameter is what lets tests assert "writes nothing"
 * without touching a real Startup folder or LaunchAgents directory.
 */
export async function runSetup(options: SetupOptions, deps: AutostartDeps): Promise<void> {
  // Platform dispatch happens before the version gate so Linux gets the
  // explicit unsupported message rather than a misleading Node error.
  const strategy = selectStrategy(deps.platform);

  if (options.unregister) {
    const removed = await strategy.unregister(deps);
    console.log(`setup: unregistered (${deps.platform}) at ${deps.now().toISOString()}`);
    for (const file of removed) console.log(`removed: ${file}`);
    return;
  }

  // The generated files pass --env-file-if-exists, which only exists in 22.9+.
  // Fail before any mkdir/write so a partial install is impossible.
  assertSupportedNode(deps.nodeVersion);

  const config = await resolveConfig(options, deps);

  if (options.print) {
    const files = strategy.buildFiles(config, deps);
    for (const file of files) {
      console.log(`=== ${file.path} ===`);
      console.log(file.content);
    }
    console.log(`setup: --print only; nothing was written (${files.length} files)`);
    return;
  }

  const files = await strategy.register(config, deps);
  console.log(
    `setup: registered taskboard watch + opencode serve for ${deps.platform} `
    + `at ${deps.now().toISOString()}`
  );
  for (const file of files) console.log(`written: ${file.path}`);
  console.log('unregister: taskboard setup --unregister');
  console.log('stop only: taskboard stop-watch | taskboard stop-opencode');
}

export async function runStop(agent: AutostartAgent, deps: AutostartDeps): Promise<void> {
  const strategy = selectStrategy(deps.platform);
  if (agent === 'watch') await strategy.stopWatch(deps);
  else await strategy.stopOpencode(deps);
}

export const setupCommand: Command = {
  summary: 'Register taskboard watch + opencode serve to start at login',
  usage: 'setup [--opencode-url URL] [--board-url URL] [--unregister] [--print]',
  bare: true,
  async run(ctx) {
    await runSetup(optionsFromFlags(ctx.flags), defaultDeps());
  }
};

export const stopWatchCommand: Command = {
  summary: 'Stop the autostarted taskboard watch sidecar',
  usage: 'stop-watch',
  bare: true,
  async run(ctx) {
    await runStop('watch', defaultDeps());
    console.log('stop-watch: stopped');
  }
};

export const stopOpencodeCommand: Command = {
  summary: 'Stop the autostarted opencode serve sidecar',
  usage: 'stop-opencode',
  bare: true,
  async run(ctx) {
    await runStop('opencode', defaultDeps());
    console.log('stop-opencode: stopped');
  }
};
