import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createDirectorySchema, directoryPatchSchema, z } from '@taskboard/core/schemas';
import { createOpenCodeSession, listOpenCodeSessions, normalizeOpenCodeBase } from '../opencode.js';

interface DirectoryParams { directoryId: string }
interface DirectorySessionQuery { workspacePath?: string; serverUrl?: string }
const createSessionSchema = z.object({
  title: z.string().min(1).max(200),
  workspacePath: z.string().min(1),
  serverUrl: z.string().min(1).max(500)
}).strict();


const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const directoriesRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/directories', async () => store.listDirectories());

  app.post('/api/directories', async (req, reply) => {
    const parsed = createDirectorySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const directory = store.createDirectory(parsed.data);
    return reply.code(201).send(directory);
  });

  app.get('/api/directories/:directoryId/opencode-sessions', async (req: FastifyRequest<{ Params: DirectoryParams; Querystring: DirectorySessionQuery }>, reply) => {
    const directory = store.getDirectory(req.params.directoryId);
    if (!directory) return reply.code(404).send({ error: `directory not found: ${req.params.directoryId}` });
    const workspacePath = String(req.query.workspacePath ?? '').trim();
    const serverUrl = String(req.query.serverUrl ?? '').trim();
    if (!workspacePath || !serverUrl) return reply.code(400).send({ error: '查询 Session 必须提供项目工作目录和 OpenCode Server URL' });
    try {
      const base = normalizeOpenCodeBase(serverUrl);
      const sessions = await listOpenCodeSessions(base, workspacePath);
      const normalizePath = (value: string): string => {
        const trimmed = value.trim().replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return /^[a-zA-Z]:\\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
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
    try {
      const session = await createOpenCodeSession(parsed.data.serverUrl, parsed.data.workspacePath, parsed.data.title);
      const normalizePath = (value: string): string => {
        const trimmed = value.trim().replace(/\\\\/g, '/').replace(/\\/+$/, '');
        return /^[a-zA-Z]:\\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
      };
      if (normalizePath(session.directory) !== normalizePath(parsed.data.workspacePath)) {
        return reply.code(502).send({ error: 'OpenCode 返回的 Session 目录与目标工作目录不一致，未绑定该 Session' });
      }
      return reply.code(201).send({ session, directoryId: directory.id, serverUrl: normalizeOpenCodeBase(parsed.data.serverUrl) });
    } catch (err) {
      return reply.code(502).send({ error: `创建 OpenCode Session 失败：${(err as Error).message}` });
    }
  });


  app.patch('/api/directories/:directoryId', async (req: FastifyRequest<{ Params: DirectoryParams }>) => {
    const parsed = directoryPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    return store.updateDirectory(req.params.directoryId, parsed.data);
  });

  app.delete('/api/directories/:directoryId', async (req: FastifyRequest<{ Params: DirectoryParams }>) => {
    store.deleteDirectory(req.params.directoryId);
    return { ok: true };
  });
};

export default directoriesRoutes;
