// Fastify app factory: wires cors, the global error handler and the route plugins.
// The Store is accepted, not created: inject one via opts.store (tests/tooling),
// or let the factory build it from opts.dataDir.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { PRIORITIES, STATUSES, Store, resolveServerConfig } from '@taskboard/core';
import type { StoreEvent, TaskboardServerConfig, TaskboardEnv } from '@taskboard/core';
import { registerErrorHandler } from './error-handler.js';
import { AuthError, BrowserAuth } from './auth.js';
import eventsRoutes from './routes/events.js';
import projectsRoutes from './routes/projects.js';
import directoriesRoutes from './routes/directories.js';
import issuesRoutes from './routes/issues.js';
import commentsRoutes from './routes/comments.js';
import dependencyRoutes from './routes/dependencies.js';
import searchRoutes from './routes/search.js';
import attachmentRoutes from './routes/attachments.js';
import backupRoutes from './routes/backup.js';
import openapiRoutes from './routes/openapi.js';

export interface ServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  webDist?: string;
  /** Inject an existing Store; otherwise a new one is created from dataDir. */
  store?: Store;
  /** Test seam: resolve every TASKBOARD_* from this env instead of process.env. */
  env?: TaskboardEnv;
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
 *
 * When `secret` is non-empty the request carries
 * `X-Taskboard-Signature: sha256=<HMAC-SHA256(rawBody, secret)>` so the
 * receiver can authenticate the payload; receivers MUST verify over the raw
 * bytes before JSON.parse.
 */
async function postWebhook(url: string, event: StoreEvent, secret: string): Promise<void> {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-taskboard-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const attempt = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
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

export async function buildApp(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; store: Store }> {
  // One env resolution for the whole app assembly — hooks, webhooks and the
  // issue routes all read from this object (defaults live in core/config.ts).
  const config = resolveServerConfig(opts.env ?? process.env);
  const effectiveHost = opts.host ?? config.host;
  // The actor header is a workflow label, not an authentication mechanism.
  // Loopback development can remain frictionless. Any non-loopback deployment
  // uses first-run admin setup + HttpOnly session cookies instead of asking the
  // browser user to paste TASKBOARD_TOKEN. TASKBOARD_TOKEN remains an optional
  // machine-client compatibility credential for CLI/MCP integrations.
  const normalizedHost = effectiveHost.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = normalizedHost === 'localhost' || normalizedHost === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalizedHost);
  const env = opts.env ?? process.env;
  const openCodeUrl = env.TASKBOARD_OPENCODE_URL;
  const publicOpenCodeUrl = env.TASKBOARD_OPENCODE_PUBLIC_URL;
  const dataDir = opts.dataDir ?? config.dataDir;
  const store = opts.store ?? new Store(dataDir);
  const browserAuth = new BrowserAuth(dataDir);
  // Once an admin is initialized, keep authentication enabled even if the
  // bind address is later changed back to loopback.
  const authRequired = env.TASKBOARD_AUTH_REQUIRED === '1' || !loopback
    || Boolean(config.token) || browserAuth.initialized;

  // T6-34: outbound webhooks. Keep the store event fan-out attached before
  // any HTTP route can mutate data.
  const hooks = config.webhookUrls;
  if (hooks.length > 0) {
    store.subscribe(event => {
      for (const url of hooks) void postWebhook(url, event, config.webhookSecret);
    });
  }

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  registerErrorHandler(app);

  const authStatus = (cookieHeader: string | undefined) => {
    const username = browserAuth.sessionUser(cookieHeader);
    return {
      authRequired,
      initialized: browserAuth.initialized,
      authenticated: !authRequired || username !== null,
      username: authRequired ? username : null
    };
  };

  // Authentication bootstrap routes are intentionally public, but setup can
  // atomically create the sole admin only once and login is rate-limited.
  app.get('/api/auth/status', async req => authStatus(req.headers.cookie));
  app.post('/api/auth/setup', async (req, reply) => {
    if (!authRequired) return reply.code(409).send({ error: '当前为本机免登录模式，无需初始化管理员' });
    const body = req.body as { username?: unknown; password?: unknown } | null;
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string'
      || Object.keys(body).some(key => key !== 'username' && key !== 'password')) {
      return reply.code(400).send({ error: 'username 和 password 均为必填字符串' });
    }
    try {
      const result = await browserAuth.initialize(body.username, body.password);
      reply.header('Set-Cookie', browserAuth.cookie(result.sessionToken, req.protocol === 'https'));
      return reply.code(201).send({ ok: true, username: result.username });
    } catch (error) {
      if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.post('/api/auth/login', async (req, reply) => {
    if (!authRequired) return reply.send({ ok: true, authRequired: false });
    const body = req.body as { username?: unknown; password?: unknown } | null;
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string'
      || Object.keys(body).some(key => key !== 'username' && key !== 'password')) {
      return reply.code(400).send({ error: 'username 和 password 均为必填字符串' });
    }
    try {
      const result = await browserAuth.login(body.username, body.password, req.ip);
      reply.header('Set-Cookie', browserAuth.cookie(result.sessionToken, req.protocol === 'https'));
      return reply.send({ ok: true, username: result.username });
    } catch (error) {
      if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.post('/api/auth/logout', async (req, reply) => {
    browserAuth.logout(req.headers.cookie);
    reply.header('Set-Cookie', browserAuth.clearCookie(req.protocol === 'https'));
    return reply.send({ ok: true });
  });

  // Protect every other API endpoint before any route handler runs. A legacy
  // bearer/query token is accepted only when explicitly configured, mainly for
  // non-browser CLI/MCP clients. Browser calls rely on the HttpOnly cookie.
  const legacyToken = config.token;
  const tokenMatches = (candidate: string): boolean => {
    if (!legacyToken) return false;
    const expected = Buffer.from(legacyToken);
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/')) return;
    if (path === '/api/auth/status' || path === '/api/auth/setup'
      || path === '/api/auth/login' || path === '/api/auth/logout'
      || path === '/api/openapi.json') return;
    // CORS preflight carries no credentials by browser design.
    if (req.raw.method === 'OPTIONS') return;

    const authorization = req.headers.authorization;
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const queryToken = req.url.includes('?')
      ? new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1)).get('token') ?? ''
      : '';
    if (tokenMatches(bearer || queryToken)) return;
    if (!authRequired || browserAuth.sessionUser(req.headers.cookie) !== null) return;
    return reply.code(401).send({ error: '请先登录 Taskboard', code: 'AUTH_REQUIRED' });
  });

  // T6-33: read-only mode. When TASKBOARD_READONLY=1, every mutating /api/*
  // request gets 403 before any route handler runs; GET (incl. SSE) is
  // untouched. Registered AFTER the auth hook, as a separate hook; HEAD and
  // OPTIONS (CORS preflight) are read-equivalents and pass through.
  if (config.readonly) {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      const method = req.raw.method ?? '';
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
      return reply.code(403).send({ error: 'read-only mode' });
    });
  }

  // Persistent global defaults are shared across browser clients and survive restarts.
  app.get('/api/settings', async () => store.getAppSettings());
  app.put('/api/settings', async (req, reply) => {
    const body = req.body as { defaultWorkspacePath?: unknown } | null;
    if (!body || Object.keys(body).some(key => key !== 'defaultWorkspacePath')
      || typeof body.defaultWorkspacePath !== 'string') {
      return reply.code(400).send({ error: 'defaultWorkspacePath must be a string' });
    }
    return store.updateAppSettings({ defaultWorkspacePath: String(body.defaultWorkspacePath) });
  });

  // ---- meta ----
  app.get('/api/meta', async () => ({ statuses: STATUSES, priorities: PRIORITIES }));

  await app.register(eventsRoutes, { store });
  await app.register(directoriesRoutes, { store, openCodeUrl, publicOpenCodeUrl });
  await app.register(projectsRoutes, { store, openCodeUrl });
  await app.register(issuesRoutes, { store, config, openCodeUrl });
  await app.register(commentsRoutes, { store, sessionUser: cookieHeader => browserAuth.sessionUser(cookieHeader) });
  await app.register(dependencyRoutes, { store });
  await app.register(searchRoutes, { store });
  await app.register(attachmentRoutes, { store });
  await app.register(backupRoutes, { store, backupDir: join(dataDir, 'backups') });
  await app.register(openapiRoutes);

  return { app, store };
}
