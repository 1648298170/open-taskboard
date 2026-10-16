// Fastify app factory: wires cors, the global error handler and the route plugins.
// The Store is accepted, not created: inject one via opts.store (tests/tooling),
// or let the factory build it from opts.dataDir.
import { timingSafeEqual } from 'node:crypto';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { PRIORITIES, STATUSES, Store } from '@taskboard/core';
import type { StoreEvent } from '@taskboard/core';
import { registerErrorHandler } from './error-handler.js';
import eventsRoutes from './routes/events.js';
import projectsRoutes from './routes/projects.js';
import issuesRoutes from './routes/issues.js';
import commentsRoutes from './routes/comments.js';
import dependencyRoutes from './routes/dependencies.js';
import searchRoutes from './routes/search.js';
import attachmentRoutes from './routes/attachments.js';
import openapiRoutes from './routes/openapi.js';

export interface ServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  webDist?: string;
  /** Inject an existing Store; otherwise a new one is created from dataDir. */
  store?: Store;
}

const WEBHOOK_TIMEOUT_MS = 3000;
const WEBHOOK_RETRY_DELAY_MS = 500;

/**
 * T6-34: POST one StoreEvent (type/payload/revision/at) as JSON to a webhook
 * endpoint, fire-and-forget. Each attempt gets a 3s AbortController timeout;
 * a failure (network error, timeout, non-2xx) is retried exactly once after
 * 500ms. This function NEVER throws — residual failures only warn, because a
 * broken receiver must never take the board (or the request that caused the
 * event) down.
 */
async function postWebhook(url: string, event: StoreEvent): Promise<void> {
  const attempt = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    try { await attempt(); return; } catch { /* one retry below */ }
    await new Promise(resolve => setTimeout(resolve, WEBHOOK_RETRY_DELAY_MS));
    await attempt();
  } catch (err) {
    console.warn(`webhook ${url} failed: ${(err as Error).message}`);
  }
}

/** Parse TASKBOARD_WEBHOOK_URL: comma-separated HTTP(S) URLs; empty/unset = off. */
const webhookUrls = (): string[] =>
  (process.env.TASKBOARD_WEBHOOK_URL ?? '')
    .split(',').map(url => url.trim()).filter(url => url.length > 0);

export async function buildApp(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; store: Store }> {
  const store = opts.store ?? new Store(opts.dataDir ?? '.data');

  // T6-34: outbound webhooks. When TASKBOARD_WEBHOOK_URL is configured, every
  // StoreEvent is fanned out to each URL via postWebhook (fire-and-forget —
  // `void`, never awaited by the emit path, never throws).
  const hooks = webhookUrls();
  if (hooks.length > 0) {
    store.subscribe(event => {
      for (const url of hooks) void postWebhook(url, event);
    });
  }

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  registerErrorHandler(app);

  // T2-9: optional LAN token auth. When TASKBOARD_TOKEN is set (non-empty),
  // every /api/* request must present it — via `Authorization: Bearer <token>`
  // or `?token=<token>`. Static files stay open (page shell loads; the API
  // calls gate the data). Unset env → hook not registered, zero behavior
  // change. Registered BEFORE all routes so it covers every API endpoint.
  const token = process.env.TASKBOARD_TOKEN;
  if (token) {
    const expected = Buffer.from(token);
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      // T7-35 × T2-9 豁免：精确匹配 openapi.json（避免前缀误伤未来路由）；
      // 其余 /api/* 仍需 token。
      if (req.url.split('?')[0] === '/api/openapi.json') return;
      // CORS preflight carries no credentials by browser design — let the
      // cors plugin answer it; the credentialed request behind it is checked.
      if (req.raw.method === 'OPTIONS') return;
      const auth = req.headers.authorization;
      const bearer = auth !== undefined && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      let queryToken = '';
      const q = req.url.indexOf('?');
      if (q >= 0) queryToken = new URLSearchParams(req.url.slice(q + 1)).get('token') ?? '';
      const candidate = Buffer.from(bearer || queryToken);
      // length guard first: timingSafeEqual throws on unequal lengths.
      const ok = candidate.length === expected.length && timingSafeEqual(candidate, expected);
      if (!ok) return reply.code(401).send({ error: 'unauthorized' });
    });
  }

  // T6-33: read-only mode. When TASKBOARD_READONLY=1, every mutating /api/*
  // request gets 403 before any route handler runs; GET (incl. SSE) is
  // untouched. Registered AFTER the auth hook, as a separate hook; HEAD and
  // OPTIONS (CORS preflight) are read-equivalents and pass through.
  if (process.env.TASKBOARD_READONLY === '1') {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      const method = req.raw.method ?? '';
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
      return reply.code(403).send({ error: 'read-only mode' });
    });
  }

  // ---- meta ----
  app.get('/api/meta', async () => ({ statuses: STATUSES, priorities: PRIORITIES }));

  await app.register(eventsRoutes, { store });
  await app.register(projectsRoutes, { store });
  await app.register(issuesRoutes, { store });
  await app.register(commentsRoutes, { store });
  await app.register(dependencyRoutes, { store });
  await app.register(searchRoutes, { store });
  await app.register(attachmentRoutes, { store });
  await app.register(openapiRoutes);

  return { app, store };
}
