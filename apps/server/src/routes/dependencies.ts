// Dependency + smart-pickup routes: per-issue dependency mutations, the
// project edge list, and the ready/next views. Store arrives via plugin
// options; mutations propagate the x-taskboard-actor header like every
// other write path.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { addDependencySchema, z } from '@taskboard/core/schemas';

interface IssueParams { id: string }
interface DependencyParams { id: string; dependsOnId: string }
interface ProjectParams { projectId: string }
// T7-34: `agent` claims the caller's perspective — issues held under
// another agent's ACTIVE lease are excluded from the pickup views.
interface AssigneeQuery { assignee?: string; agent?: string }

// One readable line per zod issue: "field: message; field: message".
const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const dependencyRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.post('/api/issues/:id/dependencies', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const parsed = addDependencySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    store.addDependency(req.params.id, parsed.data.dependsOnId, actor);
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/issues/:id/dependencies/:dependsOnId', async (req: FastifyRequest<{ Params: DependencyParams }>) => {
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    store.removeDependency(req.params.id, req.params.dependsOnId, actor);
    return { ok: true };
  });

  app.get('/api/projects/:projectId/dependencies', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    return store.projectDependencies(req.params.projectId);
  });

  app.get('/api/projects/:projectId/ready', async (req: FastifyRequest<{ Params: ProjectParams; Querystring: AssigneeQuery }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    return store.readyIssues(req.params.projectId, {
      assignee: req.query.assignee !== undefined ? String(req.query.assignee) : undefined,
      claimAgent: req.query.agent !== undefined ? String(req.query.agent) : undefined
    });
  });

  // The single best next task: first of readyIssues, or null when nothing is ready.
  app.get('/api/projects/:projectId/next', async (req: FastifyRequest<{ Params: ProjectParams; Querystring: AssigneeQuery }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    const ready = store.readyIssues(req.params.projectId, {
      assignee: req.query.assignee !== undefined ? String(req.query.assignee) : undefined,
      claimAgent: req.query.agent !== undefined ? String(req.query.agent) : undefined
    });
    return { issue: ready[0] ?? null };
  });
};

export default dependencyRoutes;
