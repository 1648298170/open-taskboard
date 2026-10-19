// /api/projects routes. Store arrives via plugin options.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createProjectSchema, projectPatchSchema, z } from '@taskboard/core/schemas';
import { listCommits, scanGitRefs } from '../git-refs.js';
import { listOpenCodeSessions, normalizeOpenCodeBase } from '../opencode.js';

interface ProjectParams { projectId: string }
interface CommitsQuery { ref?: string }
interface StatsQuery { weeks?: string }

// One readable line per zod issue: "field: message; field: message".
function normalizeDirectoryPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const projectsRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/projects', async () => store.listProjects());

  app.post('/api/projects', async (req, reply) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const input = parsed.data;

    // When a project binds a default Session, verify the binding against the
    // authoritative OpenCode server response. Legacy API clients may still
    // create an unbound project, but a supplied Session can never be accepted
    // without a workspace path and Server URL.
    if (input.defaultSessionId) {
      const workspacePath = input.workspacePath?.trim() ?? '';
      const serverUrl = input.wakeChannel?.trim() ?? '';
      if (!workspacePath || !serverUrl) {
        return reply.code(400).send({ error: '绑定默认 Session 必须同时提供项目工作目录和 OpenCode Server URL' });
      }
      try {
        const base = normalizeOpenCodeBase(serverUrl);
        const sessions = await listOpenCodeSessions(base, workspacePath);
        const expectedPath = normalizeDirectoryPath(workspacePath);
        const session = sessions.find(item => item.id === input.defaultSessionId);
        if (!session || !session.directory || normalizeDirectoryPath(session.directory) !== expectedPath) {
          return reply.code(400).send({ error: '默认 Session 不存在，或其实际工作目录与项目工作目录不一致；未创建项目' });
        }
      } catch (err) {
        return reply.code(502).send({ error: `无法验证 OpenCode Session：${(err as Error).message}` });
      }
    }
    return reply.code(201).send(store.createProject(input));
  });

  app.get('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const p = store.getProject(req.params.projectId);
    return p ?? reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
  });

  // Partial project update — name and/or the wake-channel binding. No version
  // guard (projects have no optimistic lock); last write wins like the web UI.
  app.patch('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const parsed = projectPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const patch = parsed.data;
    const current = store.getProject(req.params.projectId);
    if (!current) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });

    // Validate every explicit default-Session binding against the effective
    // workspace/server pair before persisting it.
    if (typeof patch.defaultSessionId === 'string') {
      const workspacePath = (patch.workspacePath ?? current.workspacePath).trim();
      const serverUrl = (patch.wakeChannel ?? current.wakeChannel).trim();
      if (!workspacePath || !serverUrl) {
        return reply.code(400).send({ error: '绑定默认 Session 必须同时配置项目工作目录和 OpenCode Server URL' });
      }
      try {
        const base = normalizeOpenCodeBase(serverUrl);
        const sessions = await listOpenCodeSessions(base, workspacePath);
        const expectedPath = normalizeDirectoryPath(workspacePath);
        const session = sessions.find(item => item.id === patch.defaultSessionId);
        if (!session || !session.directory || normalizeDirectoryPath(session.directory) !== expectedPath) {
          return reply.code(400).send({ error: '默认 Session 不存在，或其实际工作目录与项目工作目录不一致；未更新项目' });
        }
      } catch (err) {
        return reply.code(502).send({ error: `无法验证 OpenCode Session：${(err as Error).message}` });
      }
    }
    return store.updateProject(req.params.projectId, patch);
  });

  // OpenCode v1 sessions available to bind to a task. Sessions are read from
  // the same server URL used by the project's TUI wake channel.
  app.get('/api/projects/:projectId/opencode-sessions', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    if (!project.wakeChannel) {
      return reply.code(400).send({ error: '先在项目设置中配置 OpenCode Server URL，再选择会话' });
    }
    if (!project.workspacePath.trim()) {
      return reply.code(400).send({ error: '先在项目设置中配置工作目录，再查询 Session' });
    }
    try {
      const base = normalizeOpenCodeBase(project.wakeChannel);
      const sessions = await listOpenCodeSessions(base, project.workspacePath);
      const workspace = project.workspacePath.trim();
      const compatible = workspace
        ? sessions.filter(session => session.directory && normalizeDirectoryPath(session.directory) === normalizeDirectoryPath(workspace))
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
