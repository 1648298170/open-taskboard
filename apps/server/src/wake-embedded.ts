// Embedded wake engine (phase 2): the server process itself delivers @agent
// wakes for tasks bound to an OpenCode Session. The external `taskboard watch`
// sidecar remains the only place that acquires a file lock, drives the TUI
// channel, or spawns headless sessions; embedding only adds the bound-session
// prompt path plus a periodic pending sweep as a durability net.
//
// Lifecycle: startServer starts this after the app is built and registers
// stop() through app.addHook('onClose'). buildApp never touches the engine, so
// unit tests that only build the app can never spawn a background timer.
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import type { Store, TaskboardEnv } from '@taskboard/core';
import { startRunScheduler } from '@taskboard/wake';
import { createOpenCodeRunWorker } from './opencode-run-worker.js';
import { createWakeEngine, WATCH_REQUEST_TIMEOUT_MS } from '@taskboard/wake';
import type { FetchLike, WakeEngine } from '@taskboard/wake';
import { getConfiguredOpenCodeBase } from './opencode.js';

/** Safety-net poll cadence when no valid override is configured. */
export const WAKE_POLL_DEFAULT_MS = 60_000;
/** Anything shorter than this is a fork bomb, not a durability trigger. */
export const WAKE_POLL_MIN_MS = 5_000;

/** Test seams: production passes none of these. */
export interface WakeEmbeddedOverrides {
  /** Replace outbound OpenCode HTTP. */
  fetchImpl?: FetchLike;
  /** Programmatic interval override; env values are clamped to WAKE_POLL_MIN_MS. */
  pollMs?: number;
  /** Capture boot/delivery lines instead of writing to the console. */
  log?: (message: string, level?: 'info' | 'error') => void;
}

export interface EmbeddedWakeOptions extends WakeEmbeddedOverrides {
  store: Store;
  env: TaskboardEnv;
}

export interface EmbeddedWake {
  /** null when the kill-switch is set or no OpenCode URL is configured. */
  engine: WakeEngine | null;
  instanceId: string;
  pollMs: number;
  stop: () => Promise<void>;
}

/**
 * TASKBOARD_WAKE_POLL_MS is a *production* knob: unset or garbage falls back
 * to 60s, and any positive value below the floor is clamped up. Tests use the
 * programmatic `pollMs` override instead of racing a 5s floor.
 */
export function resolveWakePollMs(env: TaskboardEnv): number {
  const raw = Number(env.TASKBOARD_WAKE_POLL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return WAKE_POLL_DEFAULT_MS;
  return Math.max(WAKE_POLL_MIN_MS, Math.floor(raw));
}

/** Default ON: any value except the literal string '0' enables embedding. */
export function wakeEmbeddedEnabled(env: TaskboardEnv): boolean {
  return env.TASKBOARD_WAKE_EMBEDDED !== '0';
}

/** Q4§10.2 single-dispatch-path switch: '1' routes @agent wakes through
 *  the unified Run scheduler and keeps the legacy comment engine off.
 *  The two paths must never run at the same time. */
export function runSchedulerEnabled(env: TaskboardEnv): boolean {
  return env.TASKBOARD_RUN_SCHEDULER === '1';
}

export async function startEmbeddedWake(opts: EmbeddedWakeOptions): Promise<EmbeddedWake> {
  const log = opts.log ?? ((message: string, level?: 'info' | 'error') => {
    if (level === 'error') console.error(message);
    else console.log(message);
  });
  const instanceId = randomUUID().slice(0, 8);
  const pollMs = opts.pollMs ?? resolveWakePollMs(opts.env);
  const inert = (): EmbeddedWake => ({ engine: null, instanceId, pollMs, stop: async () => undefined });

  if (!wakeEmbeddedEnabled(opts.env)) {
    log('wake embedded: off (TASKBOARD_WAKE_EMBEDDED=0)');
    return inert();
  }

  let opencodeBase: string;
  try {
    // Reuse the server's single deployment-config resolution. Unlike
    // resolveOpenCodeBase(), this must NOT fall back to 127.0.0.1:4096: an
    // unconfigured deployment should stay quiet rather than poll a random host.
    opencodeBase = getConfiguredOpenCodeBase(opts.env.TASKBOARD_OPENCODE_URL);
  } catch (err) {
    const configured = (opts.env.TASKBOARD_OPENCODE_URL ?? '').trim();
    log(configured
      ? `wake embedded: off (invalid OpenCode URL: ${(err as Error).message})`
      : 'wake embedded: off (no OpenCode URL configured)');
    return inert();
  }

  if (runSchedulerEnabled(opts.env)) {
    const worker = createOpenCodeRunWorker(opts.store, { serverUrl: opencodeBase });
    const scheduler = startRunScheduler(opts.store, { worker, pollMs, heartbeatMs: 30_000 });
    log(`wake embedded: RUN SCHEDULER mode (TASKBOARD_RUN_SCHEDULER=1, instance=${instanceId}, opencode=${opencodeBase})`);
    let schedulerStopped = false;
    return {
      engine: null,
      instanceId,
      pollMs,
      stop: async () => {
        if (schedulerStopped) return;
        schedulerStopped = true;
        scheduler.stop();
      },
    };
  }
  const engine = createWakeEngine(
    {
      store: opts.store,
      fetchImpl: opts.fetchImpl ?? ((input, init) => fetch(input, init)),
      // Unreachable by construction: config.execParts is undefined below, so
      // the engine never takes the headless path. Keep a loud guard anyway.
      spawn: () => { throw new Error('wake embedded never spawns a session'); },
      randomUUID,
      homedir: () => os.homedir(),
      platform: process.platform,
      env: opts.env,
      log: (message, level) => log(`wake embedded: ${message}`, level),
      requestTimeoutMs: WATCH_REQUEST_TIMEOUT_MS,
      config: {
        prefix: '@agent',
        opencodeBase,
        // §5: explicit service identity — URL aliases of one OpenCode server
        // share a lease namespace instead of minting parallel leases.
        opencodeServiceId: opts.env.TASKBOARD_OPENCODE_SERVICE_ID?.trim() || undefined,
        // TUI and headless are external-sidecar channels only.
        tuiBase: undefined,
        execParts: undefined,
        projectFilter: undefined,
        ignoreAuthors: new Set<string>(),
      },
    },
    // No lockKey: a single server process is the only embedded instance.
    { pollMs },
  );

  await engine.start();
  const serviceId = opts.env.TASKBOARD_OPENCODE_SERVICE_ID?.trim();
  log(`wake embedded: on (instance=${instanceId}, opencode=${opencodeBase}, service=${serviceId ?? 'url-namespace'}, poll=${pollMs})`);

  let stopped = false;
  return {
    engine,
    instanceId,
    pollMs,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await engine.stop();
    },
  };
}
