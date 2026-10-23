// External wake sidecar: a thin flag/env wrapper around @taskboard/wake.
// The engine owns subscription, the startup pending sweep, CAS claiming and
// the serialized delivery queue. This command only resolves CLI config, opens
// the board database, asks for the single-instance lock, and stays resident.
//
// Type-only import: a value import here would close a runtime cycle with
// registry.js (registry imports this file for the command table) and crash
// with a TDZ error when a test/entry imports watch.js first.
import type { Command } from './registry.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store, resolveServerConfig } from '@taskboard/core';
import { createWakeEngine, WATCH_REQUEST_TIMEOUT_MS } from '@taskboard/wake';

export const watchCommand: Command = {
  summary: 'Wake an agent when a comment starts with @agent',
  usage:               'watch [--on PREFIX] [--tui-url URL] [--opencode URL] [--service-id ID] [--exec CMD] [--model M] [--project ID] [--ignore-author A,B]',
  bare: true,
  async run(ctx) {
    const { base, flags } = ctx;
    const prefix = String(flags.on ?? '@agent');
    const execParts = String(flags.exec ?? 'opencode run').split(' ').filter(s => s.length > 0);
    // Explicit model: the headless run's built-in default may be gone upstream,
    // so pin a reliable id when provided.
    const model = String(flags.model ?? process.env.OPENCODE_MODEL ?? '');
    // opencode server base — when set, tasks bound to a project Session wake
    // via prompt injection instead of a headless spawn.
    const opencodeBase = String(flags.opencode ?? process.env.OPENCODE_SERVER_URL ?? process.env.TASKBOARD_OPENCODE_URL ?? '').replace(/\/+$/, '') || undefined;
    // §5 service identity — URL aliases of one OpenCode server share this
    // lease namespace; unset keeps per-URL isolation (no guessed merging).
    const serviceId = String(flags['service-id'] ?? process.env.TASKBOARD_OPENCODE_SERVICE_ID ?? '').trim() || undefined;
    // opencode TUI remote-control base — when set, wakes append the prompt
    // into the attached TUI's input box for a human to submit.
    const tuiBase = String(flags['tui-url'] ?? process.env.OPENCODE_TUI_URL ?? '').replace(/\/+$/, '') || undefined;
    const projectFilter = String(flags.project ?? '') || undefined;
    // Self-wake guard: the sidecar's own actor is always ignored; extra agent
    // names come from --ignore-author a,b (default: no extra filtering).
    const ignoreAuthors = new Set(
      ['watch', ...String(flags['ignore-author'] ?? '').split(',')]
        .map(s => s.trim().toLowerCase()).filter(s => s.length > 0)
    );
    const channels = [
      opencodeBase ? `bound-session(${opencodeBase})` : null,
      tuiBase ? `tui-for-unbound(${tuiBase})` : null,
      `spawn-unbound(${execParts.join(' ')})`
    ].filter(Boolean).join(' → ');
    console.log(`watch: ${base()}/api/events — wake on "${prefix}…" → ${channels}${projectFilter ? ` [project ${projectFilter}]` : ''} — 项目按其 wake_channel 数据绑定投递${tuiBase ? `（--tui-url ${tuiBase} 兜底未绑定项目）` : ''}`);

    // Single-instance mutex keyed by server port + project scope: a second
    // instance for the same channel would double-inject.
    const serverPort = new URL(base()).port || '80';
    const lockId = [serverPort, projectFilter ?? 'all'].join('-').replace(/[^A-Za-z0-9.-]/g, '_');
    const lockKey = `watch-${lockId}.lock`;

    const engine = createWakeEngine(
      {
        // The engine reads and writes the board through the domain Store; it
        // no longer calls the board REST API.
        store: new Store(resolveServerConfig(process.env).dataDir),
        fetchImpl: (input, init) => fetch(input, init),
        spawn,
        randomUUID,
        homedir: () => os.homedir(),
        platform: process.platform,
        env: process.env,
        log: (message, level) => { if (level === 'error') console.error(message); else console.log(message); },
        requestTimeoutMs: WATCH_REQUEST_TIMEOUT_MS,
        config: {
          prefix,
          opencodeBase,
          opencodeServiceId: serviceId,
          tuiBase,
          execParts,
          model,
          projectFilter,
          ignoreAuthors
        }
      },
      { lockKey, pollMs: 30_000 }
    );

    await engine.start();
    // A lock conflict is a clean exit (the legacy command returned here too).
    if (!engine.isRunning()) return;
    await new Promise<void>(() => { /* stay resident */ });
  }
};
