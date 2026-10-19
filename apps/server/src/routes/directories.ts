import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createDirectorySchema, directoryPatchSchema, z } from '@taskboard/core/schemas';

interface DirectoryParams { directoryId: string }

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
