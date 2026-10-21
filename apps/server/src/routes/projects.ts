// /api/projects routes. Store arrives via plugin options.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';
import { createProjectSchema, projectPatchSchema, z } from '@taskboard/core/schemas';
import { listCommits, scanGitRefs } from '../git-refs.js';
import { listOpenCodeSessions, normalizeOpenCodeBase, resolveOpenCodeBase } from '../opencode.js';

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

// Newest-first wake channels, skipping unbound projects. `listProjects()`
// returns oldest first (ORDER BY created_at); reversing before the stable
// sort also puts later rows first when two projects share a timestamp.
const recentProjectChannels = (store: Store): string[] =>
  store.listProjects()
    .slice()
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(project => project.wakeChannel)
    .filter(channel => channel.trim().length > 0);

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

    // A Project never stores its own route. Legacy first-project flows without
    // a Directory initialize one, then every project reads these values through
    // directoryId.
    if (!directory) {
      // Backwards compatibility for legacy POST /api/projects clients: convert
      // project-level routing inputs into a new Directory instead of persisting
      // them on Project. When directoryId is supplied, Directory remains the
      // sole source of route configuration and the legacy values are ignored.
      const workspacePath = input.workspacePath?.trim() || settings.defaultWorkspacePath.trim();
      let serverUrl: string;
      try {
        serverUrl = normalizeOpenCodeBase(
          input.wakeChannel?.trim() || settings.defaultOpenCodeServerUrl.trim() || resolveOpenCodeBase(undefined, recentProjectChannels(store))
        );
      } catch (err) {
        return reply.code(400).send({ error: `OpenCode Server URL 无效：${(err as Error).message}` });
      }
      directory = store.createDirectory({
        name: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || '默认目录',
        workspacePath,
        serverUrl
      });
    }

    let serverUrl: string;
    try {
      serverUrl = normalizeOpenCodeBase(
        directory.serverUrl.trim() || settings.defaultOpenCodeServerUrl.trim() || resolveOpenCodeBase(undefined, recentProjectChannels(store))
      );
    } catch (err) {
      return reply.code(400).send({ error: `OpenCode Server URL 无效：${(err as Error).message}` });
    }
    let workspacePath = directory.workspacePath.trim();

    if (defaultSessionId) {
      try {
        const sessions = await listOpenCodeSessions(serverUrl, workspacePath);
        const session = sessions.find(item => item.id === defaultSessionId);
        if (!session) {
          return reply.code(400).send({ error: '默认 Session 不存在，或无法从目录配置的 OpenCode Server 读取；未创建项目' });
        }
        if (!workspacePath) workspacePath = (session.directory ?? '').trim();
        if (!workspacePath || !session.directory || normalizeDirectoryPath(session.directory) !== normalizeDirectoryPath(workspacePath)) {
          return reply.code(400).send({ error: '默认 Session 的实际工作目录与目录工作目录不一致；未创建项目' });
        }
        // First-run compatibility: if the Directory had an incomplete route,
        // complete the Directory itself. No route value is written to Project.
        const routePatch: { workspacePath?: string; serverUrl?: string } = {};
        if (!directory.workspacePath.trim()) routePatch.workspacePath = workspacePath;
        if (!directory.serverUrl.trim()) routePatch.serverUrl = serverUrl;
        if (Object.keys(routePatch).length) directory = store.updateDirectory(directory.id, routePatch);
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        return reply.code(502).send({ error: `无法验证 OpenCode Session：${(err as Error).message}` });
      }
    } else if (!directory.serverUrl.trim() && serverUrl) {
      directory = store.updateDirectory(directory.id, { serverUrl });
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
      try {
        const serverUrl = normalizeOpenCodeBase(
          directory.serverUrl.trim() || store.getAppSettings().defaultOpenCodeServerUrl.trim() || resolveOpenCodeBase(undefined, recentProjectChannels(store))
        );
        let workspacePath = directory.workspacePath.trim();
        const sessions = await listOpenCodeSessions(serverUrl, workspacePath);
        const session = sessions.find(item => item.id === defaultSessionId);
        if (!session) {
          return reply.code(400).send({ error: '默认 Session 不存在，或无法从目录配置的 OpenCode Server 读取；项目未更新' });
        }
        if (!workspacePath) workspacePath = (session.directory ?? '').trim();
        if (!workspacePath || !session.directory || normalizeDirectoryPath(session.directory) !== normalizeDirectoryPath(workspacePath)) {
          return reply.code(400).send({ error: '默认 Session 的实际工作目录与目录工作目录不一致；项目未更新' });
        }
        if (!directory.serverUrl.trim() || !directory.workspacePath.trim()) {
          const routePatch: { workspacePath?: string; serverUrl?: string } = {};
          if (!directory.workspacePath.trim()) routePatch.workspacePath = workspacePath;
          if (!directory.serverUrl.trim()) routePatch.serverUrl = serverUrl;
          store.updateDirectory(directory.id, routePatch);
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

  // Stateless session discovery for CLI/MCP and first-project flows. The URL is
  // optional and resolves from TASKBOARD_OPENCODE_URL, recent projects, or the
  // loopback fallback; an explicit URL always wins.
  app.get('/api/opencode/sessions', async (req: FastifyRequest<{ Querystring: { url?: string; workspacePath?: string } }>, reply) => {
    const rawUrl = String(req.query.url ?? '').trim();
    let base: string;
    try {
      base = resolveOpenCodeBase(rawUrl || undefined, recentProjectChannels(store));
    } catch (err) {
      return reply.code(400).send({ error: `url: ${(err as Error).message}` });
    }
    try {
      const workspace = String(req.query.workspacePath ?? '').trim();
      const sessions = await listOpenCodeSessions(base, workspace);
      const compatible = workspace
        ? sessions.filter(session => session.directory && normalizeDirectoryPath(session.directory) === normalizeDirectoryPath(workspace))
        : sessions;
      return { sessions: compatible, workspacePath: workspace, serverUrl: base };
    } catch (err) {
      return reply.code(502).send({ error: `无法读取 OpenCode 会话：${(err as Error).message}` });
    }
  });

  // OpenCode v1 sessions available to bind to a task. Sessions are read from
  // the same server URL used by the project's TUI wake channel.
  app.get('/api/projects/:projectId/opencode-sessions', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    if (!project.wakeChannel) {
      return reply.code(400).send({ error: '请先在所属目录配置 OpenCode Server URL，再选择会话' });
    }
    if (!project.workspacePath.trim()) {
      return reply.code(400).send({ error: '请先在所属目录配置工作目录，再查询 OpenCode Session' });
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
