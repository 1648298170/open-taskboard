import type { FastifyInstance } from 'fastify';
import type { Store } from '@taskboard/core';
import { ValidationError } from '@taskboard/core';

export default async function wakeQueueRoutes(app: FastifyInstance, opts: { store: Store }): Promise<void> {
  const store = opts.store;

  app.get('/api/wake-queue', async (req, reply) => {
    const q = req.query as { projectId?: string; limit?: string; view?: string; cursor?: string };
    const limit = q.limit ? Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200) : 50;
    const views = ['ready', 'delayed', 'queued', 'processing', 'manual'] as const;
    const view = views.includes(q.view as typeof views[number]) ? q.view as typeof views[number] : undefined;
    const snap = store.wakeQueueSnapshot(new Date().toISOString(), {
      projectId: q.projectId || undefined, limit, view, cursor: q.cursor || undefined,
    });
    // §11: cursor 携带的 revision 已过期 → 409，前端清 cursor 重载第一页
    if (snap.stale) {
      return reply.status(409).send({ error: 'queue changed; reload from the first page', code: 'STALE_QUEUE_CURSOR' });
    }
    return snap;
  });

  app.patch('/api/wake-queue/:commentId/priority', async (req, reply) => {
    const { commentId } = req.params as { commentId: string };
    const body = req.body as { priority: number; expectedPriority: number };
    if (![0, 1].includes(body.priority) || ![0, 1].includes(body.expectedPriority)) {
      return reply.status(400).send({ error: 'priority must be 0 or 1' });
    }
    const changed = store.setWakePriority(commentId, body.expectedPriority, body.priority);
    if (!changed) {
      const meta = store.queueMeta(commentId);
      if (!meta) return reply.status(404).send({ error: 'comment not found' });
      if (meta.terminalAt) return reply.status(409).send({ error: 'terminal comments cannot be reprioritized; use controlled recovery' });
      if (meta.status !== 'pending') return reply.status(409).send({ error: 'comment is not pending' });
      return reply.status(409).send({ error: 'priority was changed by another request; refresh and retry' });
    }
    return { ok: true, queuePriority: body.priority };
  });
}
