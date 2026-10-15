// Fastify app factory: wires cors, the global error handler and the route plugins.
// The Store is accepted, not created: inject one via opts.store (tests/tooling),
// or let the factory build it from opts.dataDir.
import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { PRIORITIES, STATUSES, Store } from '@taskboard/core';
import { registerErrorHandler } from './error-handler.js';
import eventsRoutes from './routes/events.js';
import projectsRoutes from './routes/projects.js';
import issuesRoutes from './routes/issues.js';
import commentsRoutes from './routes/comments.js';

export interface ServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  webDist?: string;
  /** Inject an existing Store; otherwise a new one is created from dataDir. */
  store?: Store;
}

export async function buildApp(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; store: Store }> {
  const store = opts.store ?? new Store(opts.dataDir ?? '.data');

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  registerErrorHandler(app);

  // ---- meta ----
  app.get('/api/meta', async () => ({ statuses: STATUSES, priorities: PRIORITIES }));

  await app.register(eventsRoutes, { store });
  await app.register(projectsRoutes, { store });
  await app.register(issuesRoutes, { store });
  await app.register(commentsRoutes, { store });

  return { app, store };
}
