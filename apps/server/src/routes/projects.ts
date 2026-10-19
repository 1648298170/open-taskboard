// /api/projects routes. Store arrives via plugin options.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createProjectSchema, projectPatchSchema, z } from '@taskboard/core/schemas';
import { listCommits, scanGitRefs } from '../git-refs.js';
import { listOpenCodeSessions, normalizeOpenCodeBase } from '../opencode.js';
import { resolve } from 'node:path';

interface ProjectParams { projectId: string }
interface CommitsQuery { ref?: string }
interface StatsQuery { weeks?: string }

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

  // Partial project update — name and/or the wake-channel binding. No version
  // guard (projects have no optimistic lock); last write wins like the web UI.
  app.patch('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>) => {
    const parsed = projectPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    return store.updateProject(req.params.projectId, parsed.data);
  });

  // OpenCode v1 sessions available to bind to a task. Sessions are read from
  // the same server URL used by the project's TUI wake channel.
  app.get('/api/projects/:projectId/opencode-sessions', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    if (!project.wakeChannel) {
      return reply.code(400).send({ error: '先在项目设置中配置 OpenCode 唤醒端口，再选择会话' });
    }
    try {
      const base = normalizeOpenCodeBase(project.wakeChannel);
      const sessions = await listOpenCodeSessions(base);
      const normalizePath = (value: string): string => {
        const absolute = resolve(value).replace(/\\\\/g, '/').replace(/\/$/, '');
        return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      };
      const workspace = project.workspacePath.trim();
      const compatible = workspace
        ? sessions.filter(session => session.directory && normalizePath(session.directory) === normalizePath(workspace))
        : sessions;
      return { sessions: compatible, workspacePath: workspace, serverUrl: base };
    } catch (err) {
      return reply.code(502).send({ error: `无法读取 OpenCode 会话：${(err as Error).message}` });
    }
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

  // T6-31: stats panel aggregate. `weeks` falls back to 8 on a missing or
  // non-numeric value; the store clamps the final range to 1..26 (so an
  // out-of-range number keeps its direction, e.g. 0/−3 → 1, 99 → 26).
  app.get('/api/projects/:projectId/stats', async (req: FastifyRequest<{ Params: ProjectParams; Querystring: StatsQuery }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    const raw = Number.parseInt(String(req.query.weeks ?? ''), 10);
    return store.projectStats(req.params.projectId, { weeks: Number.isFinite(raw) ? raw : 8 });
  });

  app.delete('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>) => {
    store.deleteProject(req.params.projectId);
    return { ok: true };
  });
};

export default projectsRoutes;
