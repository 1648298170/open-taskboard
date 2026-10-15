// Realtime SSE endpoint — byte-for-byte the semantics of the former inline route:
// hello + change events, unsubscribe on connection close, never-resolving handler.
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Store } from '@taskboard/core';

const eventsRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`event: hello\ndata: {"revision":${store.revision()}}\n\n`);
    const unsubscribe = store.subscribe(e => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`));
    await new Promise<void>(resolve => {
      req.raw.on('close', () => { unsubscribe(); resolve(); });
    });
  });
};

export default eventsRoutes;
