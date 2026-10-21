// Platform dispatch for autostart. Commands stay platform-agnostic: they call
// selectStrategy(process.platform) and the strategy owns templates + process
// management. Linux is intentionally rejected for now.
import { realpathSync } from 'node:fs';
import { darwinStrategy } from './darwin.js';
import { win32Strategy } from './win32.js';
import { runQuietly, type AutostartDeps, type AutostartStrategy } from './types.js';

/**
 * Node/opencode launchers are often shims (fnm multishells, pnpm, nvm). Those
 * paths contain a per-shell id and disappear after reboot, so resolve the real
 * file when possible. A non-existent path (tests, broken install) is kept
 * as-is so the error surfaces at launch instead of at setup time.
 */
export function canonicalizeExecutable(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export function selectStrategy(platform: NodeJS.Platform): AutostartStrategy {
  if (platform === 'win32') return win32Strategy;
  if (platform === 'darwin') return darwinStrategy;
  throw new Error(`setup: platform not supported yet (win32/darwin only): ${platform}`);
}

/**
 * Resolve the opencode launcher once, at registration time. A bare `opencode`
 * is kept as the fallback so a PATH change after setup still has a chance to
 * work; a resolved absolute path is preferred so login environments with a
 * minimal PATH keep working.
 *
 * Candidates are canonicalized first (so a multishell shim collapses to the
 * currently active install), then ranked: on Windows a real `.cmd` beats the
 * extension-less shell shim, and any still-ephemeral path is demoted.
 */
export async function resolveOpencodeCommand(deps: AutostartDeps): Promise<string> {
  const lookup = deps.platform === 'win32' ? 'where' : 'which';
  const result = await runQuietly(deps, lookup, ['opencode']);
  if (result.code === 0) {
    const resolved = result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(canonicalizeExecutable);
    const rank = (line: string): number => {
      let score = 0;
      if (/fnm_multishells/i.test(line)) score += 4;
      if (deps.platform === 'win32' && !/\.cmd$/i.test(line)) score += 2;
      return score;
    };
    const preferred = [...new Set(resolved)].sort((a, b) => rank(a) - rank(b));
    const first = preferred[0];
    if (first !== undefined) return first;
  }
  return 'opencode';
}

export { darwinStrategy, win32Strategy };
export type {
  AutostartAgent,
  AutostartDeps,
  AutostartStrategy,
  ExecResult,
  GeneratedFile,
  SetupConfig
} from './types.js';
