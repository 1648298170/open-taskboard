// /api/issues/:id/comments routes. Store arrives via plugin options.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { addCommentSchema, commentPatchSchema, z } from '@taskboard/core/schemas';

interface IssueParams { id: string }
interface CommentParams { commentId: string }

// One readable line per zod issue: "field: message; field: message".
const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const commentsRoutes: FastifyPluginAsync<{
  store: Store;
  sessionUser: (cookieHeader: string | undefined) => string | null;
}> = async (app, { store, sessionUser }) => {
  app.get('/api/issues/:id/comments', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    if (!store.getIssue(req.params.id)) {
      return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    }
    return store.listComments(req.params.id);
  });

  app.post('/api/issues/:id/comments', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const parsed = addCommentSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const authenticatedUsername = sessionUser(req.headers.cookie);
    const requestActor = String(req.headers['x-taskboard-actor'] ?? '');
    // A valid browser session owns the author field. Ignore any author supplied
    // by the client so a browser cannot impersonate another user or an agent.
    const author = authenticatedUsername ?? parsed.data.author ?? requestActor;
    const actor = authenticatedUsername ?? requestActor;
    return reply.code(201).send(store.addComment(req.params.id, { ...parsed.data, author }, actor));
  });

  // Partial comment update — edit the body or advance/reset the wake status.
  // Comments have no optimistic lock (last write wins); blank-body/locked
  // state errors surface as ValidationError → 400 via the global handler.
  app.patch('/api/comments/:commentId', async (req: FastifyRequest<{ Params: CommentParams }>) => {
    const parsed = commentPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const authenticatedUsername = sessionUser(req.headers.cookie);
    const actor = authenticatedUsername ?? String(req.headers['x-taskboard-actor'] ?? '');
    return store.updateComment(req.params.commentId, parsed.data, actor, authenticatedUsername);
  });

  app.delete('/api/comments/:commentId', async (req: FastifyRequest<{ Params: CommentParams }>) => {
    const authenticatedUsername = sessionUser(req.headers.cookie);
    const actor = authenticatedUsername ?? String(req.headers['x-taskboard-actor'] ?? '');
    store.deleteComment(req.params.commentId, actor);
    return { ok: true };
  });
};

export default commentsRoutes;
