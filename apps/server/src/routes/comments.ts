// /api/issues/:id/comments routes. Store arrives via plugin options.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { addCommentSchema, z } from '@taskboard/core/schemas';

interface IssueParams { id: string }

// One readable line per zod issue: "field: message; field: message".
const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const commentsRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/issues/:id/comments', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    if (!store.getIssue(req.params.id)) {
      return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    }
    return store.listComments(req.params.id);
  });

  app.post('/api/issues/:id/comments', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const parsed = addCommentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    return reply.code(201).send(store.addComment(req.params.id, parsed.data, actor));
  });
};

export default commentsRoutes;
