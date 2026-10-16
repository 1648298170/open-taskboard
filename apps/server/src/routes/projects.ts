// /api/projects routes. Store arrives via plugin options.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createProjectSchema, z } from '@taskboard/core/schemas';
import { listCommits, scanGitRefs } from '../git-refs.js';

interface ProjectParams { projectId: string }
interface CommitsQuery { ref?: string }

// One readable line per zod issue: "field: message; field: message".
const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const projectsRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/projects', async () => store.listProjects());

  app.post('/api/projects', async (req, reply) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    return reply.code(201).send(store.createProject(parsed.data));
  });

  app.get('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const p = store.getProject(req.params.projectId);
    return p ?? reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
  });

  // T2-8: branches + worktrees of the project's workspacePath. Git failures
  // (not a repo, git missing, timeout) surface as empty arrays, never 500s.
  app.get('/api/projects/:projectId/git-refs', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const p = store.getProject(req.params.projectId);
    if (!p) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    return scanGitRefs(p.workspacePath);
  });

  // T6-36: recent commits for a branch or worktree of the project workspace.
  // ref matching a worktree NAME → that worktree's checkout at HEAD; anything
  // else is treated as a ref inside workspacePath. Git failures → empty list.
  app.get('/api/projects/:projectId/commits', async (req: FastifyRequest<{ Params: ProjectParams; Querystring: CommitsQuery }>, reply) => {
    const p = store.getProject(req.params.projectId);
    if (!p) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    const ref = (req.query.ref ?? '').trim();
    if (!ref || !p.workspacePath) return { commits: [] };
    const worktree = (await scanGitRefs(p.workspacePath)).worktrees.find(w => w.name === ref);
    if (worktree) return { commits: await listCommits(worktree.path) };
    return { commits: await listCommits(p.workspacePath, ref) };
  });

  app.delete('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>) => {
    store.deleteProject(req.params.projectId);
    return { ok: true };
  });
};

export default projectsRoutes;
