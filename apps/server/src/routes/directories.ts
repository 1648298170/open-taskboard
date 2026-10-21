import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createDirectorySchema, directoryPatchSchema, z } from '@taskboard/core/schemas';
import { createOpenCodeSession, getOpenCodeSessionRuntimeState, listOpenCodeDirectories, listOpenCodeSessions, normalizeOpenCodeBase } from '../opencode.js';

interface DirectoryParams { directoryId: string }
interface DirectoryBrowseQuery { path?: string; serverUrl?: string }
const createSessionSchema = z.object({
  title: z.string().min(1).max(200)
}).strict();


const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const directoriesRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/directories/browse', async (
    req: FastifyRequest<{ Querystring: DirectoryBrowseQuery }>,
    reply
  ) => {
    const serverUrl = String(req.query.serverUrl ?? '').trim();
    const path = String(req.query.path ?? '').trim();
    if (!serverUrl) return reply.code(400).send({ error: '选择工作目录必须提供 OpenCode Server URL' });
    if (serverUrl.length > 500 || path.length > 4096) {
      return reply.code(400).send({ error: 'OpenCode Server URL 或目录路径过长' });
    }
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

  app.get('/api/directories/:directoryId/opencode-status', async (
    req: FastifyRequest<{ Params: DirectoryParams }>,
    reply
  ) => {
    const directory = store.getDirectory(req.params.directoryId);
    if (!directory) return reply.code(404).send({ error: `directory not found: ${req.params.directoryId}` });
    const projects = store.listProjects().filter(project => project.directoryId === directory.id);
    const checkedAt = new Date().toISOString();
    const serverUrl = directory.serverUrl.trim();

    if (!serverUrl) {
      return {
        directoryId: directory.id, name: directory.name, workspacePath: directory.workspacePath,
        serverUrl, checkedAt, serverStatus: 'unconfigured',
        error: '请先在目录右键菜单中配置 OpenCode Server URL',
        projects: projects.map(project => ({
          projectId: project.id, projectName: project.name, sessionId: project.defaultSessionId,
          status: project.defaultSessionId ? 'unavailable' : 'no-session',
          busy: null, error: '目录尚未配置 OpenCode Server URL'
        }))
      };
    }

    let serverError: string | undefined;
    try {
      await listOpenCodeSessions(normalizeOpenCodeBase(serverUrl), directory.workspacePath.trim());
    } catch (error) {
      serverError = (error as Error).message;
    }

    const projectStates = await Promise.all(projects.map(async project => {
      const sessionId = project.defaultSessionId?.trim() ?? '';
      if (!sessionId) {
        return { projectId: project.id, projectName: project.name, sessionId: null, status: 'no-session', busy: null };
      }
      if (serverError) {
        return { projectId: project.id, projectName: project.name, sessionId, status: 'unavailable', busy: null, error: serverError };
      }
      try {
        const state = await getOpenCodeSessionRuntimeState(
          normalizeOpenCodeBase(serverUrl), directory.workspacePath.trim(), sessionId
        );
        return {
          projectId: project.id, projectName: project.name, sessionId,
          status: state.busy ? 'busy' : (state.status?.type ?? 'idle'),
          busy: state.busy, statusType: state.status?.type ?? null, observedAt: state.observedAt
        };
      } catch (error) {
        return { projectId: project.id, projectName: project.name, sessionId, status: 'unavailable', busy: null, error: (error as Error).message };
      }
    }));

    return {
      directoryId: directory.id, name: directory.name, workspacePath: directory.workspacePath,
      serverUrl, checkedAt, serverStatus: serverError ? 'unavailable' : 'connected',
      ...(serverError ? { error: serverError } : {}), projects: projectStates
    };
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
    const serverUrl = directory.serverUrl.trim();
    if (!workspacePath || !serverUrl) return reply.code(400).send({ error: '请先在目录中配置工作目录和 OpenCode Server URL' });
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
      return { sessions: compatible, directoryId: directory.id, directoryPath: workspacePath, serverUrl: base };
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
    const serverUrl = directory.serverUrl.trim();
    if (!workspacePath || !serverUrl) return reply.code(400).send({ error: '请先在目录中配置工作目录和 OpenCode Server URL' });
    try {
      const session = await createOpenCodeSession(serverUrl, workspacePath, parsed.data.title);
      const normalizePath = (value: string): string => {
        const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        return /^[a-zA-Z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
      };
      if (normalizePath(session.directory) !== normalizePath(workspacePath)) {
        return reply.code(502).send({ error: 'OpenCode 返回的 Session 目录与目标工作目录不一致，未绑定该 Session' });
      }
      return reply.code(201).send({ session, directoryId: directory.id, serverUrl: normalizeOpenCodeBase(serverUrl) });
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
