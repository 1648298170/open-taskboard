import type { AgentRun, RunStatus, Store } from '@taskboard/core';
import type { RunWorker, RunWorkerOutcome } from '@taskboard/wake';
import { findCorrelatedAssistant } from '@taskboard/wake';
import { abortOpenCodeSession, getOpenCodeSessionRuntimeState } from './opencode.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface OpenCodeRunWorkerOptions {
  serverUrl: string;
  directory?: string;
  pollIntervalMs?: number;
  busyWaitTimeoutMs?: number;
  evidenceTimeoutMs?: number;
}

type OutcomePatch = {
  resultSummary?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  exitCode?: number | null;
  providerSessionId?: string | null;
};

interface AssistantLike {
  info?: { error?: unknown };
  parts?: { type: string; text?: string }[];
}

/**
 * RunWorker over the existing verified OpenCode integration (Q3). Reuses the
 * wake engine's correlation protocol (marker + findCorrelatedAssistant) and
 * the server's session runtime-state/abort helpers — no second dispatch
 * implementation. §9.2 ordering: probe before send; 2xx is only
 * "sent, awaiting evidence"; 5xx/network → interrupted (never blind-resend).
 */
export function createOpenCodeRunWorker(store: Store, options: OpenCodeRunWorkerOptions): RunWorker {
  const poll = options.pollIntervalMs ?? 1_000;
  const busyCap = options.busyWaitTimeoutMs ?? 60_000;
  const evidenceCap = options.evidenceTimeoutMs ?? 600_000;
  const dir = options.directory ?? '';
  const base = options.serverUrl.replace(/\/+$/, '');

  const fetchMessages = async (sessionId: string): Promise<unknown> => {
    const res = await fetch(`${base}/session/${encodeURIComponent(sessionId)}/message?limit=50`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`messages HTTP ${res.status}`);
    return res.json();
  };

  return {
    async execute(run: AgentRun, api: {
      transition(to: RunStatus, patch?: OutcomePatch): void;
      event(type: string, payload?: Record<string, unknown>): void;
    }): Promise<RunWorkerOutcome> {
      const nowIso = (): string => new Date().toISOString();
      const fail = (errorCode: string, errorMessage: string): RunWorkerOutcome => ({
        status: 'failed',
        patch: { errorCode, errorMessage },
      });
      const interrupted = (errorCode: string, errorMessage: string): RunWorkerOutcome => ({
        status: 'interrupted',
        patch: { errorCode, errorMessage },
      });

      // preflight — deterministic, fail-closed, zero network
      const issue = store.getIssue(run.issueId);
      if (!issue) return fail('ISSUE_NOT_FOUND', 'issue vanished before dispatch');
      if (issue.archivedAt) return fail('ISSUE_ARCHIVED', 'issue archived before dispatch');
      if (issue.status === 'done') return fail('ISSUE_NOT_EXECUTABLE', 'issue done before dispatch');
      const project = store.getProject(issue.projectId);
      if (!project) return fail('ISSUE_NOT_FOUND', `project ${issue.projectId} missing`);
      if (!run.providerSessionId) return fail('SESSION_REQUIRED', 'run has no bound session');
      if (project.defaultSessionId !== run.providerSessionId) {
        return fail('SESSION_WORKSPACE_MISMATCH', 'project session changed since claim; refusing stale dispatch');
      }
      if ((project.workspacePath ?? '') !== run.workspacePath) {
        return fail('SESSION_WORKSPACE_MISMATCH', 'project workspace changed since claim; refusing stale dispatch');
      }
      const sessionId = run.providerSessionId;

      // probe — unknown runtime state must never send
      let busy = false;
      try {
        busy = (await getOpenCodeSessionRuntimeState(options.serverUrl, dir, sessionId)).busy;
      } catch (err) {
        return interrupted('RUNTIME_UNAVAILABLE', `session probe failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
      }
      const busyDeadline = Date.now() + busyCap;
      while (busy) {
        if (Date.now() > busyDeadline) return fail('RESOURCE_BUSY', 'session stayed busy past the pre-send wait window');
        await sleep(poll);
        try {
          busy = (await getOpenCodeSessionRuntimeState(options.serverUrl, dir, sessionId)).busy;
        } catch {
          return interrupted('RUNTIME_UNAVAILABLE', 'session probe failed during busy wait');
        }
      }

      // send — marker-correlated prompt
      const marker = `taskboard-run:${run.id}:${run.dispatchId ?? 'none'}`;
      const prompt = `${run.promptSnapshot}\n\n[Taskboard correlation marker: ${marker}. Treat this as metadata; do not repeat it in your answer.]`;
      try {
        const res = await fetch(`${base}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          await res.body?.cancel().catch(() => undefined);
        } else {
          const code = res.status;
          await res.body?.cancel().catch(() => undefined);
          return code < 500
            ? fail('OPENCODE_REJECTED', `prompt_async returned HTTP ${code}`)
            : interrupted('RUNTIME_UNAVAILABLE', `prompt_async HTTP ${code}; result unknown`);
        }
      } catch (err) {
        return interrupted('RUNTIME_UNAVAILABLE', `prompt_async failed before response: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
      }
      api.transition('running', { providerSessionId: sessionId });
      api.event('prompt_sent', { marker, sessionId });

      // evidence loop — 2xx alone is never success
      const deadline = Date.now() + evidenceCap;
      while (Date.now() < deadline) {
        await sleep(poll);
        let correlation: { matchedPrompt: boolean; assistant?: AssistantLike };
        try {
          correlation = findCorrelatedAssistant(await fetchMessages(sessionId), marker) as typeof correlation;
        } catch {
          continue; // transient read failure stays inside the verification window
        }
        if (correlation.assistant) {
          const err = correlation.assistant.info?.error;
          if (err) return fail('OPENCODE_AGENT_ERROR', String(err).slice(0, 500));
          const text = (correlation.assistant.parts ?? [])
            .filter(part => part.type === 'text')
            .map(part => String(part.text ?? ''))
            .join('\n')
            .slice(0, 500);
          return { status: 'succeeded', patch: { resultSummary: text } };
        }
      }
      return interrupted('RUNTIME_UNAVAILABLE', 'no correlated assistant evidence within the verification window');
    },

    async cancel(run: AgentRun): Promise<'requested' | 'confirmedStopped' | 'unsupported'> {
      if (!run.providerSessionId) return 'unsupported';
      try {
        await abortOpenCodeSession(options.serverUrl, dir, run.providerSessionId);
        return 'confirmedStopped';
      } catch {
        return 'requested';
      }
    },
  };
}
