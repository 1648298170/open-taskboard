// /api/issues routes (list/create under a project, progress, get/patch/delete by id,
// archive, and the T7-34 claim/lease endpoints). Store arrives via plugin
// options. JSON bodies are validated with the shared zod schemas — no
// hand-rolled type assertions.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createTaskWorktree, GitWorktreeError, scanGitRefs } from '../git-refs.js';
import { abortOpenCodeSession, getConfiguredOpenCodeBase, getOpenCodeSessionRuntimeState, openOpenCodeEventStream } from '../opencode.js';
import { STATUSES, Store, ValidationError } from '@taskboard/core';
import type { Status, TaskboardServerConfig } from '@taskboard/core';
import { claimSchema, createIssueSchema, restUpdateIssueSchema, z } from '@taskboard/core/schemas';

interface IssueParams { id: string }
interface ProjectParams { projectId: string }

// projectId comes from the route path, not the JSON body.
const createIssueBodySchema = createIssueSchema.omit({ projectId: true });

// One readable line per zod issue: "field: message; field: message".
const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

const normalizeGitPath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};


function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** OpenCode event envelopes differ by event type; only forward events explicitly tied to this Session. */
function openCodeEventBelongsToSession(event: unknown, sessionId: string): boolean {
  if (!isUnknownRecord(event)) return false;
  const payload = isUnknownRecord(event.payload) ? event.payload : event;
  const properties = isUnknownRecord(payload.properties) ? payload.properties : {};
  const info = isUnknownRecord(properties.info) ? properties.info : {};
  const part = isUnknownRecord(properties.part) ? properties.part : {};
  const candidates = [
    event.sessionID, event.sessionId,
    payload.sessionID, payload.sessionId,
    properties.sessionID, properties.sessionId,
    info.sessionID, info.sessionId, info.id,
    part.sessionID, part.sessionId
  ];
  return candidates.some(value => typeof value === 'string' && value === sessionId);
}

function normalizeOpenCodeDirectory(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

const issuesRoutes: FastifyPluginAsync<{ store: Store; config: TaskboardServerConfig }> = async (app, { store, config }) => {
  app.get('/api/projects/:projectId/issues', async (req: FastifyRequest<{ Params: ProjectParams; Querystring: { status?: Status; parentId?: string; includeDone?: string; archived?: string } }>, reply) => {
    if (!store.getProject(req.params.projectId)) {
      return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    }
    const q = req.query;
    if (q.status !== undefined && !(STATUSES as readonly string[]).includes(q.status)) {
      return reply.code(400).send({ error: `invalid status: ${q.status}` });
    }
    // T5-24: 'only' / 'all'; absent (or any other value rejected) → default
    // excludes archived rows.
    let archived: 'only' | 'all' | undefined;
    if (q.archived !== undefined) {
      if (q.archived !== 'only' && q.archived !== 'all') {
        return reply.code(400).send({ error: `invalid archived filter: ${q.archived} (expected 'only' | 'all')` });
      }
      archived = q.archived;
    }
    return store.listIssues(req.params.projectId, {
      status: q.status,
      parentId: q.parentId !== undefined ? (q.parentId === 'null' ? null : q.parentId) : undefined,
      includeDone: q.includeDone !== 'false',
      archived
    });
  });

  app.post('/api/projects/:projectId/issues', async (req: FastifyRequest<{ Params: ProjectParams }>, reply) => {
    const parsed = createIssueBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const project = store.getProject(req.params.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${req.params.projectId}` });
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    // The browser creates task content only. Execution metadata is Agent-managed.
    if (actor === 'web' && ['branch', 'worktree', 'worktreePath', 'assignee']
      .some(key => (parsed.data as Record<string, unknown>)[key] !== undefined)) {
      return reply.code(403).send({ error: '负责人、Git 分支和工作树属性由 Agent 维护' });
    }
    // Every task inherits its Session from the owning Project. Legacy sessionId
    // body/header values are ignored and can never override the Project binding.
    if (actor === 'web' && !project.defaultSessionId) {
      return reply.code(400).send({ error: '创建任务前必须先在所属项目配置默认 OpenCode Session' });
    }
    // T7-36 门禁的 create 侧：直接以 status:'done' 创建与 PATCH 置 done 同责，
    // 非 web 来源不能通过客户端自报 confirm 绕过人工完成门禁。
    if (config.humanDone && parsed.data.status === 'done' &&
        String(req.headers['x-taskboard-actor'] ?? '') !== 'web') {
      return reply.code(403).send({ error: 'done requires human confirmation' });
    }
    // v0.4: in_review 评论门禁的 create 侧——创建即 in_review 时评论尚不可
    // 能存在，非 web 来源必须先创建任务，再评论并提交验收。
    if (config.reviewComment && parsed.data.status === 'in_review' &&
        String(req.headers['x-taskboard-actor'] ?? '') !== 'web') {
      return reply.code(403).send({ error: 'in_review requires a comment by this actor (先落评再交验)' });
    }
    // 兼容旧客户端的 confirm 字段不作为审批凭证，且不透传 Store
    const { confirm: _confirm, ...body } = parsed.data;
    return reply.code(201).send(store.createIssue({ ...body, projectId: req.params.projectId }, actor));
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
      comments: store.listComments(issue.id),
      activities: store.listActivities(issue.id),
      attachments: store.listAttachments(issue.id),
      ...store.listDependencies(req.params.id)
    };
  });

  app.patch('/api/issues/:id', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const parsed = restUpdateIssueSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const currentIssue = store.getIssue(req.params.id);
    if (!currentIssue) return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    // Session, assignee and git execution metadata are maintained by Project /
    // Agent workflows; the browser may not override them through issue PATCH.
    if (actor === 'web' && ['branch', 'worktree', 'worktreePath', 'assignee', 'sessionId']
      .some(key => (parsed.data as Record<string, unknown>)[key] !== undefined)) {
      return reply.code(403).send({ error: 'Session、负责人、Git 分支和工作树属性由项目配置或 Agent 维护' });
    }
    const statusChanging = parsed.data.status !== undefined && parsed.data.status !== currentIssue.status;
    // Every agent-driven status transition must carry its audit note in the
    // same PATCH request. Store persists the status + comment in one SQLite
    // transaction. Web actions are exempt here; Store writes an automatic,
    // explicitly-labelled audit comment when the UI supplies no note.
    if (statusChanging && actor !== 'web' && !parsed.data.statusNote?.trim()) {
      return reply.code(403).send({
        error: 'status transition requires statusNote; include the reason, verification evidence, and any unchecked items'
      });
    }
    // Opening work also requires a session binding. Check this after the
    // audit-note gate so callers get the most relevant missing-field error.
    if (config.requireSession && parsed.data.status === 'in_progress'
      && currentIssue.status !== 'in_progress'
      && actor !== 'web'
      && !currentIssue.sessionId) {
      return reply.code(403).send({
        error: 'starting a task requires a Project default Session; task-level sessionId cannot override project routing (TASKBOARD_REQUIRE_SESSION)'
      });
    }
    // T7-36: optional human final-review gate. With TASKBOARD_HUMAN_DONE=1, only
    // the web UI (x-taskboard-actor: 'web') may set status to done — CLI/MCP
    // agents must bring the task to in_review and wait for human confirmation
    // on the web board. The gate runs before the store call (cheap header
    // check first), so a gated request gets 403 even with a stale version.
    // Only direct status='done' patches are gated; other statuses and archive
    // are unaffected. Default (env unset/empty): zero behavior change.
    // confirm is retained for request compatibility, but is not proof of human approval.
    // The actor header remains a workflow label; it must not be treated as identity authentication.
    if (config.humanDone && parsed.data.status === 'done' &&
        String(req.headers['x-taskboard-actor'] ?? '') !== 'web') {
      return reply.code(403).send({ error: 'done requires human confirmation' });
    }
    // 兼容旧客户端的 confirm 字段不作为审批凭证，且不透传 Store
    const { version, confirm, statusNote, ...patch } = parsed.data;
    return store.updateIssue(req.params.id, patch, version, actor, statusNote);
  });

  // Create and bind an isolated Git worktree for this task. Git and SQLite
  // cannot share a transaction, so the handler validates first and reports an
  // explicit orphan path if Git succeeds but persistence fails.
  app.post('/api/issues/:id/create-worktree', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const issue = store.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    const project = store.getProject(issue.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${issue.projectId}` });
    if (issue.claimedBy && issue.leaseExpiresAt && Date.parse(issue.leaseExpiresAt) > Date.now()) {
      return reply.code(409).send({ error: '任务当前有有效执行租约；请先释放租约再创建或切换 Worktree' });
    }

    const refs = await scanGitRefs(project.workspacePath);
    if (issue.worktreePath && refs.worktrees.some(w => normalizeGitPath(w.path) === normalizeGitPath(issue.worktreePath!))) {
      // Retry is idempotent when the task is already bound to its real worktree.
      return { issue, branch: issue.branch, worktree: issue.worktree, worktreePath: issue.worktreePath, alreadyBound: true };
    }
    if (issue.branch || issue.worktree || issue.worktreePath) {
      return reply.code(409).send({
        error: '任务已有 Git 绑定。为避免覆盖现有分支或工作树，请先确认并解除绑定后再自动创建'
      });
    }

    try {
      const created = await createTaskWorktree(project.workspacePath, project.id, issue.id, issue.title);
      const siblings = store.listIssues(issue.projectId, { archived: 'all' });
      const collision = siblings.find(other => other.id !== issue.id &&
        (normalizeGitPath(other.worktreePath) === normalizeGitPath(created.path) || other.branch === created.branch));
      if (collision) {
        // This should be rare (concurrent requests), but never bind one Git
        // execution context to multiple tasks. Keep the created path visible.
        return reply.code(409).send({
          error: `Worktree 已创建但绑定冲突：任务 #${collision.id} 已使用同一分支或路径；请检查并手动清理 ${created.path}`
        });
      }
      try {
        const updated = store.updateIssue(issue.id, {
          branch: created.branch,
          worktree: created.name,
          worktreePath: created.path
        }, issue.version, String(req.headers['x-taskboard-actor'] ?? 'web'));
        return reply.code(201).send({
          issue: updated,
          branch: created.branch,
          worktree: created.name,
          worktreePath: created.path,
          alreadyBound: false
        });
      } catch (error) {
        return reply.code(500).send({
          error: `Worktree 已创建，但任务绑定写入失败。请勿重复创建；先检查路径并手动绑定：${created.path}。原因：${(error as Error).message}`
        });
      }
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // Unbind metadata only. The local branch/worktree is intentionally preserved.
  app.delete('/api/issues/:id/git-binding', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const issue = store.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    if (issue.claimedBy && issue.leaseExpiresAt && Date.parse(issue.leaseExpiresAt) > Date.now()) {
      return reply.code(409).send({ error: '任务当前有有效执行租约；请先释放租约再解除 Git 绑定' });
    }
    const actor = String(req.headers['x-taskboard-actor'] ?? 'web');
    return store.updateIssue(issue.id, { branch: '', worktree: null, worktreePath: null }, issue.version, actor);
  });


  // Runtime snapshot is the recovery path after Taskboard reload/restart. The
  // Session ID is persisted on the issue; OpenCode remains authoritative for
  // whether its agent is busy. This endpoint does not mutate task workflow status.
  app.get('/api/issues/:id/opencode-state', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const issue = store.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    if (!issue.sessionId?.trim()) return reply.code(409).send({ error: '任务尚未绑定 OpenCode Session' });
    const project = store.getProject(issue.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${issue.projectId}` });
    let serverUrl: string;
    try { serverUrl = getConfiguredOpenCodeBase(); }
    catch (err) { return reply.code(503).send({ error: (err as Error).message }); }
    const directory = issue.worktreePath.trim() || project.workspacePath.trim();
    if (!directory) return reply.code(400).send({ error: '任务没有可用的工作目录' });
    try {
      const state = await getOpenCodeSessionRuntimeState(serverUrl, directory, issue.sessionId);
      if (state.directory && normalizeOpenCodeDirectory(state.directory) !== normalizeOpenCodeDirectory(directory)) {
        return reply.code(409).send({ error: `OpenCode Session 的实际目录与任务执行目录不一致：${state.directory}` });
      }
      return { ...state, issueStatus: issue.status, recoverable: true };
    } catch (err) {
      return reply.code(502).send({ error: `无法恢复 OpenCode Session 状态：${(err as Error).message}` });
    }
  });

  // Cancellation reaches the owning OpenCode server; it is not merely a
  // Taskboard status change. The task itself remains in its workflow column.
  app.post('/api/issues/:id/opencode-abort', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const issue = store.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    if (!issue.sessionId?.trim()) return reply.code(409).send({ error: '任务尚未绑定 OpenCode Session' });
    const project = store.getProject(issue.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${issue.projectId}` });
    if (!project.wakeChannel.trim()) return reply.code(400).send({ error: '请先配置项目的 OpenCode Server URL' });
    const directory = issue.worktreePath.trim() || project.workspacePath.trim();
    try {
      const runtime = await getOpenCodeSessionRuntimeState(project.wakeChannel, directory, issue.sessionId);
      if (runtime.directory && normalizeOpenCodeDirectory(runtime.directory) !== normalizeOpenCodeDirectory(directory)) {
        return reply.code(409).send({ error: `OpenCode Session 的实际目录与任务执行目录不一致：${runtime.directory}` });
      }
      if (!runtime.busy) {
        return reply.code(409).send({ error: 'OpenCode Session 当前未报告执行中；请先重新同步状态' });
      }
      await abortOpenCodeSession(serverUrl, directory, issue.sessionId);
      store.recordExecutionEvent(
        issue.id,
        'cancel_requested',
        `已向 OpenCode Session ${issue.sessionId} 发送取消请求；任务状态未自动变更`,
        String(req.headers['x-taskboard-actor'] ?? 'web')
      );
      return { ok: true, sessionId: issue.sessionId, requestedAt: new Date().toISOString() };
    } catch (err) {
      return reply.code(502).send({ error: `取消 OpenCode 执行失败：${(err as Error).message}` });
    }
  });

  // Proxy the upstream OpenCode SSE stream, filtering out events from other
  // sessions. Browser EventSource reconnects automatically; clients first
  // reload /opencode-state to reconcile events missed while disconnected.
  app.get('/api/issues/:id/opencode-events', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const issue = store.getIssue(req.params.id);
    if (!issue) return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    if (!issue.sessionId?.trim()) return reply.code(409).send({ error: '任务尚未绑定 OpenCode Session' });
    const project = store.getProject(issue.projectId);
    if (!project) return reply.code(404).send({ error: `project not found: ${issue.projectId}` });
    if (!project.wakeChannel.trim()) return reply.code(400).send({ error: '请先配置项目的 OpenCode Server URL' });
    const directory = issue.worktreePath.trim() || project.workspacePath.trim();
    const controller = new AbortController();
    let upstream: Response;
    try {
      upstream = await openOpenCodeEventStream(serverUrl, directory, controller.signal);
    } catch (err) {
      return reply.code(502).send({ error: `无法订阅 OpenCode 事件：${(err as Error).message}` });
    }

    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ issueId: issue.id, sessionId: issue.sessionId, at: new Date().toISOString() })}\n\n`);

    const stop = (): void => { if (!controller.signal.aborted) controller.abort(); };
    res.on('close', stop);
    res.on('error', stop);
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body!) {
        if (controller.signal.aborted || res.destroyed) break;
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          const delimiter = /^\r?\n\r?\n/.exec(buffer.slice(boundary))?.[0] ?? '\n\n';
          buffer = buffer.slice(boundary + delimiter.length);
          const data = frame.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
          if (data) {
            try {
              const parsed: unknown = JSON.parse(data);
              if (openCodeEventBelongsToSession(parsed, issue.sessionId!)) {
                res.write(`event: opencode\ndata: ${JSON.stringify(parsed)}\n\n`);
              }
            } catch {
              // Ignore malformed/non-JSON upstream frames; do not break the stream.
            }
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted && !res.destroyed) {
        res.write(`event: upstream-error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
      }
    } finally {
      res.off('close', stop);
      res.off('error', stop);
      await upstream.body?.cancel().catch(() => undefined);
      if (!res.writableEnded) res.end();
    }
    return reply;
  });

  app.post('/api/issues/:id/agent-events', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const eventSchema = z.object({ outcome: z.enum(['started', 'queued', 'running', 'idle', 'retrying', 'succeeded', 'failed', 'cancel_requested']), detail: z.string().trim().min(1).max(2000) });
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const actor = String(req.headers['x-taskboard-actor'] ?? 'watch');
    return reply.code(201).send(store.recordExecutionEvent(req.params.id, parsed.data.outcome, parsed.data.detail, actor));
  });

  app.delete('/api/issues/:id', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    store.deleteIssue(req.params.id);
    return { ok: true };
  });

  // T5-24: archive / unarchive. Like every write path, the actor header is
  // propagated; NotFoundError → 404 via the global error handler.
  app.post('/api/issues/:id/archive', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    store.archiveIssue(req.params.id, actor);
    return { ok: true };
  });

  app.post('/api/issues/:id/unarchive', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    store.unarchiveIssue(req.params.id, actor);
    return { ok: true };
  });

  // T7-34: exclusive claim / lease endpoints. Bodies all follow claimSchema
  // (heartbeat renews with an optional fresh ttl; release only needs the
  // agent — a ttl there is ignored). Each responds with the updated Issue;
  // claim conflicts flow through ConflictError → 409 via the global handler.
  app.post('/api/issues/:id/claim', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    if (config.requireSession && !store.getIssue(req.params.id)?.sessionId
      && String(req.headers['x-taskboard-actor'] ?? '') !== 'web') {
      return reply.code(403).send({
        error: 'starting a task requires a Project default Session; task-level sessionId cannot override project routing (TASKBOARD_REQUIRE_SESSION)'
      });
    }
    return store.claimIssue(req.params.id, parsed.data.agent, parsed.data.ttlMinutes ?? 30, actor || parsed.data.agent, undefined, parsed.data.branch);
  });

  app.post('/api/issues/:id/heartbeat', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    return store.heartbeatIssue(req.params.id, parsed.data.agent, parsed.data.ttlMinutes ?? 30);
  });

  app.post('/api/issues/:id/release', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    return store.releaseIssue(req.params.id, parsed.data.agent, actor || parsed.data.agent);
  });
};

export default issuesRoutes;
