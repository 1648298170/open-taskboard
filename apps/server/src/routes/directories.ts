import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createDirectorySchema, directoryPatchSchema, z } from '@taskboard/core/schemas';
import { createOpenCodeSession, listOpenCodeSessions, normalizeOpenCodeBase } from '../opencode.js';

interface DirectoryParams { directoryId: string }
const createSessionSchema = z.object({ title: z.string().min(1).max(200) }).strict();

function normalizeDirectoryPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const directoriesRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/directories', async () => store.listDirectories());

  app.post('/api/directories', async (req, reply) => {
    const parsed = createDirectorySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const directory = store.createDirectory({ ...parsed.data, serverUrl: parsed.data.serverUrl ?? '' });
    return reply.code(201).send(directory);
  });

  app.get('/api/directories/:directoryId/opencode-sessions', async (req: FastifyRequest<{ Params: DirectoryParams }>, reply) => {
    const directory = store.getDirectory(req.params.directoryId);
    if (!directory) return reply.code(404).send({ error: `directory not found: ${req.params.directoryId}` });
    if (!directory.serverUrl) return reply.code(400).send({ error: '请先为工作目录配置 OpenCode Server URL' });
    try {
      const serverUrl = normalizeOpenCodeBase(directory.serverUrl);
      const sessions = await listOpenCodeSessions(serverUrl, directory.path);
      const expectedPath = normalizeDirectoryPath(directory.path);
      const compatible = sessions.filter(session =>
        session.directory && normalizeDirectoryPath(session.directory) === expectedPath
      );
      return { sessions: compatible, directoryId: directory.id, directoryPath: directory.path, serverUrl };
    } catch (err) {
      return reply.code(502).send({ error: `无法读取 OpenCode 会话：${(err as Error).message}` });
    }
  });

  app.post('/api/directories/:directoryId/opencode-sessions', async (req: FastifyRequest<{ Params: DirectoryParams }>, reply) => {
    const directory = store.getDirectory(req.params.directoryId);
    if (!directory) return reply.code(404).send({ error: `directory not found: ${req.params.directoryId}` });
    if (!directory.serverUrl) return reply.code(400).send({ error: '请先为工作目录配置 OpenCode Server URL' });
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    try {
      const session = await createOpenCodeSession(directory.serverUrl, directory.path, parsed.data.title);
      if (normalizeDirectoryPath(session.directory) !== normalizeDirectoryPath(directory.path)) {
        return reply.code(502).send({ error: 'OpenCode 返回的 Session 目录与目标工作目录不一致，未绑定该 Session' });
      }
      return reply.code(201).send({ session, directoryId: directory.id, serverUrl: normalizeOpenCodeBase(directory.serverUrl) });
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
