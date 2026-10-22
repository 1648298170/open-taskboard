import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createDirectorySchema, directoryPatchSchema, z } from '@taskboard/core/schemas';
import { buildOpenCodePublicSessionUrl, createOpenCodeSession, getOpenCodePublicOrigin, getConfiguredOpenCodeBase, getOpenCodeSessionRuntimeState, listOpenCodeDirectories, listOpenCodeSessions, normalizeOpenCodeBase } from '../opencode.js';

interface DirectoryParams { directoryId: string }
interface DirectoryBrowseQuery { path?: string }
const createSessionSchema = z.object({
  title: z.string().min(1).max(200)
}).strict();


const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const directoriesRoutes: FastifyPluginAsync<{ store: Store; openCodeUrl?: string; publicOpenCodeUrl?: string }> = async (app, { store, openCodeUrl, publicOpenCodeUrl }) => {
  app.get('/api/directories/browse', async (
    req: FastifyRequest<{ Querystring: DirectoryBrowseQuery }>,
    reply
  ) => {
    const path = String(req.query.path ?? '').trim();
    if (path.length > 4096) return reply.code(400).send({ error: '目录路径过长' });
    let serverUrl: string;
    try { serverUrl = getConfiguredOpenCodeBase(openCodeUrl); }
    catch (err) { return reply.code(503).send({ error: (err as Error).message }); }
    const isWindowsDrivePath = /^[A-Za-z]:[\\/]/.test(path);
    const isWindowsUncPath = path.startsWith('\\\\');
    if (path && !path.startsWith('/') && !isWindowsDrivePath && !isWindowsUncPath) {
      return reply.code(400).send({ error: '目录路径必须是 OpenCode Server 上的绝对路径' });
    }
    try {
      // The OpenCode server, not the Taskboard container, owns this filesystem.
      return await listOpenCodeDirectories(serverUrl, path);
    } catch (err) {
      return reply.code(502).send({ error: `无法读取 OpenCode 目录：${(err as Error).message}` });
    }
  });

  app.get('/api/directories', async () => store.listDirectories());

  // Global OpenCode health snapshot. It is deployment-configured and never tied to a directory.
  app.get('/api/opencode/status', async (_req, reply) => {
    const checkedAt = new Date().toISOString();
    const publicOrigin = getOpenCodePublicOrigin(publicOpenCodeUrl);
    let serverUrl: string;
    try {
      serverUrl = getConfiguredOpenCodeBase(openCodeUrl);
      await listOpenCodeSessions(serverUrl);
    } catch (err) {
      return reply.code(200).send({
        checkedAt, serverStatus: 'unavailable', publicOrigin,
        error: (err as Error).message, projects: []
      });
    }

    const projects = store.listProjects();
    const states = await Promise.all(projects.map(async project => {
      const directory = project.directoryId ? store.getDirectory(project.directoryId) : null;
      const workspacePath = directory?.workspacePath.trim() ?? '';
      const sessionId = project.defaultSessionId?.trim() ?? '';
      const base = {
        projectId: project.id, projectName: project.name,
        directoryName: directory?.name ?? '未关联目录',
        workspacePath, sessionId: sessionId || null,
        sessionUrl: sessionId ? buildOpenCodePublicSessionUrl(workspacePath, sessionId, publicOpenCodeUrl) : null
      };
      if (!sessionId) return { ...base, status: 'no-session', busy: null };
      if (!workspacePath) return { ...base, status: 'unavailable', busy: null, error: '项目未配置工作目录' };
      try {
        const state = await getOpenCodeSessionRuntimeState(serverUrl, workspacePath, sessionId);
        return {
          ...base, status: state.busy ? 'busy' : (state.status?.type ?? 'idle'),
          busy: state.busy, statusType: state.status?.type ?? null,
          observedAt: state.observedAt
        };
      } catch (err) {
        return { ...base, status: 'unavailable', busy: null, error: (err as Error).message };
      }
    }));
    return { checkedAt, serverStatus: 'connected', publicOrigin, projects: states };
  });


  app.post('/api/directories', async (req, reply) => {
    const parsed = createDirectorySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const directory = store.createDirectory(parsed.data);
    return reply.code(201).send(directory);
  });

  app.get('/api/directories/:directoryId/opencode-sessions', async (req: FastifyRequest<{ Params: DirectoryParams }>, reply) => {
    const directory = store.getDirectory(req.params.directoryId);
    if (!directory) return reply.code(404).send({ error: `directory not found: ${req.params.directoryId}` });
    const workspacePath = directory.workspacePath.trim();
    let serverUrl: string;
    try { serverUrl = getConfiguredOpenCodeBase(openCodeUrl); }
    catch (err) { return reply.code(503).send({ error: (err as Error).message }); }
    if (!workspacePath) return reply.code(400).send({ error: '请先在目录中配置工作目录' });
    try {
      const base = normalizeOpenCodeBase(serverUrl);
      const sessions = await listOpenCodeSessions(base, workspacePath);
      const normalizePath = (value: string): string => {
        const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        return /^[a-zA-Z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
      };
      const expectedPath = normalizePath(workspacePath);
      const compatible = sessions.filter(session =>
        session.directory && normalizePath(session.directory) === expectedPath
      );
      return { sessions: compatible, directoryId: directory.id, directoryPath: workspacePath };
    } catch (err) {
      return reply.code(502).send({ error: `无法读取 OpenCode 会话：${(err as Error).message}` });
    }
  });

  app.post('/api/directories/:directoryId/opencode-sessions', async (req: FastifyRequest<{ Params: DirectoryParams }>, reply) => {
    const directory = store.getDirectory(req.params.directoryId);
    if (!directory) return reply.code(404).send({ error: `directory not found: ${req.params.directoryId}` });
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const workspacePath = directory.workspacePath.trim();
    let serverUrl: string;
    try { serverUrl = getConfiguredOpenCodeBase(openCodeUrl); }
    catch (err) { return reply.code(503).send({ error: (err as Error).message }); }
    if (!workspacePath) return reply.code(400).send({ error: '请先在目录中配置工作目录' });
    try {
      const session = await createOpenCodeSession(serverUrl, workspacePath, parsed.data.title);
      const normalizePath = (value: string): string => {
        const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        return /^[a-zA-Z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
      };
      if (normalizePath(session.directory) !== normalizePath(workspacePath)) {
        return reply.code(502).send({ error: 'OpenCode 返回的 Session 目录与目标工作目录不一致，未绑定该 Session' });
      }
      return reply.code(201).send({ session, directoryId: directory.id });
    } catch (err) {
      return reply.code(502).send({ error: `创建 OpenCode Session 失败：${(err as Error).message}` });
    }
  });


  app.patch('/api/directories/:directoryId', async (req: FastifyRequest<{ Params: DirectoryParams }>) => {
    const parsed = directoryPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    return store.updateDirectory(req.params.directoryId, parsed.data);
  });

  app.delete('/api/directories/:directoryId', async (req: FastifyRequest<{ Params: DirectoryParams; Querystring: { cascade?: string } }>) => {
    const cascade = req.query.cascade === '1' || req.query.cascade === 'true';
    store.deleteDirectory(req.params.directoryId, { cascadeProjects: cascade });
    return { ok: true };
  });
};

export default directoriesRoutes;
