// /api/issues routes (list/create under a project, progress, get/patch/delete by id).
// Store arrives via plugin options. JSON bodies are validated with the shared
// zod schemas — no hand-rolled type assertions.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { STATUSES, Store, ValidationError } from '@taskboard/core';
import type { Status } from '@taskboard/core';
import { createIssueSchema, restUpdateIssueSchema, z } from '@taskboard/core/schemas';

interface IssueParams { id: string }
interface ProjectParams { projectId: string }

// projectId comes from the route path, not the JSON body.
const createIssueBodySchema = createIssueSchema.omit({ projectId: true });

// One readable line per zod issue: "field: message; field: message".
const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const issuesRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/projects/:projectId/issues', async (req: FastifyRequest<{ Params: ProjectParams; Querystring: { status?: Status; parentId?: string; includeDone?: string } }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    const q = req.query;
    if (q.status !== undefined && !(STATUSES as readonly string[]).includes(q.status)) {
      return reply.code(400).send({ error: `invalid status: ${q.status}` });
    }
    return store.listIssues(req.params.projectId, {
      status: q.status,
      parentId: q.parentId !== undefined ? (q.parentId === 'null' ? null : q.parentId) : undefined,
      includeDone: q.includeDone !== 'false'
    });
  });

  app.post('/api/projects/:projectId/issues', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const parsed = createIssueBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    return reply.code(201).send(store.createIssue({ ...parsed.data, projectId: req.params.projectId }));
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

  app.patch('/api/issues/:id', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    const parsed = restUpdateIssueSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const { version, ...patch } = parsed.data;
    return store.updateIssue(req.params.id, patch, version);
  });

  app.delete('/api/issues/:id', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    store.deleteIssue(req.params.id);
    return { ok: true };
  });
};

export default issuesRoutes;
