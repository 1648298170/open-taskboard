import type { FastifyInstance } from 'fastify';
import type { Store } from '@taskboard/core';
import { ConflictError, NotFoundError, ValidationError } from '@taskboard/core';

const VIEWS = ['queued', 'active', 'needs_attention', 'terminal', 'all'] as const;

export default async function agentRunRoutes(app: FastifyInstance, opts: { store: Store }): Promise<void> {
  const store = opts.store;

  // §7.1: create a run — 202 + runId, idempotency key reuses the original Run
  app.post('/api/issues/:id/agent-runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      prompt?: string; idempotencyKey?: string; priority?: number; sourceType?: 'manual' | 'comment_wake';
    };
    const prompt = (body.prompt ?? '').trim() || `execute issue ${id}`;
    try {
      const run = store.createAgentRun(id, {
        prompt: prompt.slice(0, 20_000),
        sourceType: body.sourceType ?? 'manual',
        idempotencyKey: body.idempotencyKey,
        priority: body.priority,
      });
      return reply.status(202).send({
        runId: run.id, status: run.status, queuedAt: run.queuedAt,
        idempotencyKey: run.idempotencyKey, attemptNo: run.attemptNo,
      });
    } catch (err) {
      if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message, code: 'ISSUE_NOT_FOUND' });
      if (err instanceof ValidationError) {
        const code = err.message.includes('ISSUE_ARCHIVED') ? 'ISSUE_ARCHIVED' : 'ISSUE_NOT_EXECUTABLE';
        return reply.status(400).send({ error: err.message, code });
      }
      throw err;
    }
  });

  // §7.2: per-issue run history (keyset pagination, newest first)
  app.get('/api/issues/:id/agent-runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: string; cursor?: string };
    const limit = q.limit ? Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200) : 50;
    if (!store.getIssue(id)) return reply.status(404).send({ error: 'issue not found', code: 'ISSUE_NOT_FOUND' });
    return store.listAgentRunsByIssue(id, limit, q.cursor);
  });

  // §7.2: queue center — filter first, then paginate; counts across views
  app.get('/api/agent-runs', async (req) => {
    const q = req.query as { view?: string; status?: string; projectId?: string; limit?: string; cursor?: string };
    const view = VIEWS.includes(q.view as typeof VIEWS[number]) ? q.view as typeof VIEWS[number] : undefined;
    const status = q.status as import('@taskboard/core').RunStatus | undefined;
    const limit = q.limit ? Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200) : 50;
    return store.listAgentRunsQueue({
      view, status, projectId: q.projectId || undefined, limit, cursor: q.cursor || undefined,
    });
  });

  // §7.2: run snapshot + capability flags (cancel/retry visibility)
  app.get('/api/agent-runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = store.getAgentRun(runId);
    if (!run) return reply.status(404).send({ error: 'run not found', code: 'RUN_NOT_FOUND' });
    const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
    return {
      run,
      capabilities: {
        cancel: !terminal,
        retry: terminal || run.status === 'interrupted',
        messages: false, // CAPABILITY_UNSUPPORTED until a provider proves it (§7.3)
        resume: false,
      },
    };
  });

  // §7.2: structured event history after a sequence cursor
  app.get('/api/agent-runs/:runId/events', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const q = req.query as { afterSequence?: string; limit?: string };
    const afterSequence = q.afterSequence ? Math.max(parseInt(q.afterSequence, 10) || 0, 0) : 0;
    const limit = q.limit ? Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 200) : 100;
    try {
      return { events: store.listRunEvents(runId, afterSequence, limit) };
    } catch (err) {
      if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message, code: 'RUN_NOT_FOUND' });
      throw err;
    }
  });

  // §7.3: cancel — stable results, never fake `cancelled`
  app.post('/api/agent-runs/:runId/cancel', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = store.getAgentRun(runId);
    if (!run) return reply.status(404).send({ error: 'run not found', code: 'RUN_NOT_FOUND' });
    const terminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
    if (terminal) return reply.status(409).send({ error: 'run is already terminal', code: 'RUN_ALREADY_TERMINAL' });
    // RunScheduler owns provider-cancel semantics; the API layer handles the
    // queued fast-path and hands active runs to the registered cancel hook.
    const result = store.cancelQueuedAgentRun(runId);
    if (result) return { ok: true, result: 'cancelled' };
    return reply.status(202).send({ ok: true, result: 'requested', code: 'CANCEL_REQUESTED' });
  });

  // §7.3: retry — verify, then create a child run with a fresh key
  app.post('/api/agent-runs/:runId/retry', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    try {
      const child = store.retryAgentRun(runId);
      return reply.status(202).send({ runId: child.id, status: child.status, attemptNo: child.attemptNo });
    } catch (err) {
      if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message, code: 'RUN_NOT_FOUND' });
      if (err instanceof ValidationError) return reply.status(409).send({ error: err.message, code: 'RUN_STATE_CONFLICT' });
      if (err instanceof ConflictError) return reply.status(409).send({ error: err.message, code: 'IDEMPOTENCY_CONFLICT' });
      throw err;
    }
  });
}
