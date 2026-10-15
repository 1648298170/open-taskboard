// Fastify service: REST API + SSE + static hosting of the built web board.
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIORITIES, STATUSES, Status, Priority, Store } from '@taskboard/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
// monorepo layout: apps/server/dist -> ../../ -> repo root -> apps/web/dist/web
const WEB_DIST = join(__dirname, '..', '..', '..', 'apps', 'web', 'dist', 'web');

export interface ServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  webDist?: string;
}

interface IssueParams { id: string }
interface ProjectParams { projectId: string }

export async function buildApp(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; store: Store }> {
  const store = new Store(opts.dataDir ?? '.data');

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });

  // ---- meta ----
  app.get('/api/meta', async () => ({ statuses: STATUSES, priorities: PRIORITIES }));

  // ---- realtime (SSE) ----
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
    req.raw.on('close', unsubscribe);
    await new Promise(() => { /* keep the stream open */ });
  });

  // ---- projects ----
  app.get('/api/projects', async () => store.listProjects());

  app.post('/api/projects', async (req, reply) => {
    const body = req.body as { id?: string; name?: string; workspacePath?: string };
    if (!body.name) return reply.code(400).send({ error: 'name is required' });
    return reply.code(201).send(store.createProject({ ...body, name: body.name }));
  });

  app.get('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const p = store.getProject(req.params.projectId);
    return p ?? reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
  });

  app.delete('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>) => {
    store.deleteProject(req.params.projectId);
    return { ok: true };
  });

  // ---- issues ----
  app.get('/api/projects/:projectId/issues', async (req: FastifyRequest<{ Params: ProjectParams; Querystring: { status?: Status; parentId?: string; includeDone?: string } }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    const q = req.query;
    return store.listIssues(req.params.projectId, {
      status: q.status,
      parentId: q.parentId !== undefined ? (q.parentId === 'null' ? null : q.parentId) : undefined,
      includeDone: q.includeDone !== 'false'
    });
  });

  app.post('/api/projects/:projectId/issues', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const body = req.body as { title?: string; parentId?: string | null; description?: string; status?: Status; priority?: Priority; labels?: string; branch?: string; assignee?: string };
    if (!body.title) return reply.code(400).send({ error: 'title is required' });
    return reply.code(201).send(store.createIssue({ projectId: req.params.projectId, ...body, title: body.title }));
  });

  app.get('/api/projects/:projectId/progress', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    return store.projectProgress(req.params.projectId);
  });

  app.get('/api/issues/:id', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const issue = store.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    return {
      ...issue,
      children: issue.parentId ? [] : store.listIssues(issue.projectId, { parentId: issue.id }),
      comments: store.listComments(issue.id)
    };
  });

  app.patch('/api/issues/:id', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const body = req.body as { version?: number } & Record<string, unknown>;
    const { version, ...patch } = body;
    try {
      return store.updateIssue(req.params.id, patch, version);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/issues/:id', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    store.deleteIssue(req.params.id);
    return { ok: true };
  });

  // ---- comments ----
  app.get('/api/issues/:id/comments', async (req: FastifyRequest<{ Params: IssueParams }>) =>
    store.listComments(req.params.id));

  app.post('/api/issues/:id/comments', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const body = req.body as { author?: string; body?: string };
    if (!body.body) return reply.code(400).send({ error: 'body is required' });
    return reply.code(201).send(store.addComment(req.params.id, { ...body, body: body.body }));
  });

  return { app, store };
}

export async function startServer(opts: ServerOptions = {}) {
  const host = opts.host ?? process.env.TASKBOARD_HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.TASKBOARD_PORT ?? 47824);
  const { app, store } = await buildApp(opts);

  const staticRoot = opts.webDist
    ?? process.env.TASKBOARD_WEB_DIST
    ?? WEB_DIST;
  if (existsSync(join(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/' });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      return '<meta charset="utf-8"><body style="font-family:monospace;background:#101312;color:#d6e2dc;padding:40px">' +
        '看板未构建 — 先运行 <code>pnpm build</code>，或开发模式 <code>pnpm dev</code>（vite 在 :5174）</body>';
    });
  }

  await app.listen({ host, port });
  return { app, store, url: `http://${host}:${port}` };
}

// direct run: node dist/server.js (or tsx src/server.ts)
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('server.ts')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('server.js');
if (invokedDirectly) {
  startServer({ dataDir: process.env.TASKBOARD_DATA_DIR || '.data' }).then(({ url }) => {
    console.log(`opencode-taskboard listening on ${url}`);
    console.log(`data dir: ${process.env.TASKBOARD_DATA_DIR || '.data'}/taskboard.sqlite`);
  });
}
