// /api/projects routes. Store arrives via plugin options.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createProjectSchema, projectPatchSchema, z } from '@taskboard/core/schemas';
import { listCommits, scanGitRefs } from '../git-refs.js';
import { getConfiguredOpenCodeBase, listOpenCodeSessions } from '../opencode.js';

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
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    const input = parsed.data;
    const defaultSessionId = input.defaultSessionId !== undefined
      ? input.defaultSessionId
      : (input.sessionId ?? null);

    if (actor === 'web' && !defaultSessionId?.trim()) {
      return reply.code(400).send({ error: '新建项目必须先选择一个 OpenCode Session' });
    }

    const settings = store.getAppSettings();
    let directory = input.directoryId ? store.getDirectory(input.directoryId) : null;
    if (input.directoryId && !directory) {
      return reply.code(404).send({ error: `directory not found: ${input.directoryId}` });
    }

    // OpenCode routing is deployment-level; directories and projects only store workspace/session metadata.
    if (!directory) {
      const workspacePath = input.workspacePath?.trim() || settings.defaultWorkspacePath.trim();
      directory = store.createDirectory({
        name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || '默认目录',
        workspacePath
      });
    }

    let workspacePath = directory.workspacePath.trim();
    let serverUrl: string;
    try { serverUrl = getConfiguredOpenCodeBase(); }
    catch (err) { return reply.code(503).send({ error: (err as Error).message }); }

    if (defaultSessionId) {
      if (input.directoryId && !workspacePath) {
        return reply.code(400).send({ error: '请先在所属目录中配置工作目录，再绑定项目默认 Session' });
      }
      try {
        const sessions = await listOpenCodeSessions(serverUrl, workspacePath);
        const session = sessions.find(item => item.id === defaultSessionId);
        if (!session) {
          return reply.code(400).send({ error: '默认 Session 不存在，或无法从部署配置的 OpenCode Server 读取；未创建项目' });
        }
        if (!workspacePath) workspacePath = (session.directory ?? '').trim();
        if (!workspacePath || !session.directory || normalizeDirectoryPath(session.directory) !== normalizeDirectoryPath(workspacePath)) {
          return reply.code(400).send({ error: '默认 Session 的实际工作目录与目录工作目录不一致；未创建项目' });
        }
        if (!directory.workspacePath.trim()) {
          directory = store.updateDirectory(directory.id, { workspacePath });
        }
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        return reply.code(502).send({ error: `无法验证 OpenCode Session：${(err as Error).message}` });
      }
    }

    return reply.code(201).send(store.createProject({
      ...(input.id ? { id: input.id } : {}),
      name: input.name,
      directoryId: directory.id,
      ...(defaultSessionId !== null ? { defaultSessionId } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {})
    }));
  });

  app.get('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const p = store.getProject(req.params.projectId);
    return p ?? reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
  });

  // Project updates are limited to name, labels and the default Session. Route
  // changes must go through Directory so every project inherits one source.
  app.patch('/api/projects/:projectId', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const parsed = projectPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const input = parsed.data;
    const current = store.getProject(req.params.projectId);
    if (!current) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });

    const hasDefaultSessionPatch = input.defaultSessionId !== undefined || input.sessionId !== undefined;
    const defaultSessionId = input.defaultSessionId !== undefined
      ? input.defaultSessionId
      : input.sessionId === '' ? null : input.sessionId;

    if (typeof defaultSessionId === 'string') {
      const directory = current.directoryId ? store.getDirectory(current.directoryId) : null;
      if (!directory) return reply.code(409).send({ error: '项目未关联目录，无法解析 OpenCode 路由' });
      const workspacePath = directory.workspacePath.trim();
      if (!workspacePath) {
        return reply.code(400).send({ error: '请先在所属目录中配置工作目录，再绑定默认 Session' });
      }
      try {
        const serverUrl = getConfiguredOpenCodeBase();
        const sessions = await listOpenCodeSessions(serverUrl, workspacePath);
        const session = sessions.find(item => item.id === defaultSessionId);
        if (!session) {
          return reply.code(400).send({ error: '默认 Session 不存在，或无法从部署配置的 OpenCode Server 读取；项目未更新' });
        }
        if (!session.directory || normalizeDirectoryPath(session.directory) !== normalizeDirectoryPath(workspacePath)) {
          return reply.code(400).send({ error: '默认 Session 的实际工作目录与目录工作目录不一致；项目未更新' });
        }
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        return reply.code(502).send({ error: `无法验证 OpenCode Session：${(err as Error).message}` });
      }
    }

    const update: { name?: string; labels?: string; defaultSessionId?: string | null } = {};
    if (input.name !== undefined) update.name = input.name;
    if (input.labels !== undefined) update.labels = input.labels;
    if (hasDefaultSessionPatch) update.defaultSessionId = defaultSessionId ?? null;
    return store.updateProject(req.params.projectId, update);
  });

  // Stateless session discovery always uses the deployment-configured server.
  app.get('/api/opencode/sessions', async (req: FastifyRequest<{ Querystring: { url?: string; workspacePath?: string } }>, reply) => {
    let base: string;
    try { base = getConfiguredOpenCodeBase(); }
    catch (err) { return reply.code(503).send({ error: (err as Error).message }); }
    try {
      const workspace = String(req.query.workspacePath ?? '').trim();
      const sessions = await listOpenCodeSessions(base, workspace);
      const compatible = workspace
        ? sessions.filter(session => session.directory && normalizeDirectoryPath(session.directory) === normalizeDirectoryPath(workspace))
        : sessions;
      return { sessions: compatible, workspacePath: workspace };
    } catch (err) {
      return reply.code(502).send({ error: `无法读取 OpenCode 会话：${(err as Error).message}` });
    }
  });

  // OpenCode sessions available to bind to a project; URL comes from deployment configuration.
  app.get('/api/projects/:projectId/opencode-sessions', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    if (!project.workspacePath.trim()) {
      return reply.code(400).send({ error: '请先在所属目录配置工作目录，再查询 OpenCode Session' });
    }
    try {
      const base = getConfiguredOpenCodeBase();
      const sessions = await listOpenCodeSessions(base, project.workspacePath);
      const workspace = project.workspacePath.trim();
      const compatible = workspace
        ? sessions.filter(session => session.directory && normalizeDirectoryPath(session.directory) === normalizeDirectoryPath(workspace))
        : sessions;
      return { sessions: compatible, workspacePath: workspace };
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
