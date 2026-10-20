// /api/issues routes (list/create under a project, progress, get/patch/delete by id,
// archive, and the T7-34 claim/lease endpoints). Store arrives via plugin
// options. JSON bodies are validated with the shared zod schemas — no
// hand-rolled type assertions.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createTaskWorktree, GitWorktreeError, scanGitRefs } from '../git-refs.js';
import { STATUSES, Store, ValidationError, resolveIssueSessionId } from '@taskboard/core';
import type { Status, TaskboardServerConfig } from '@taskboard/core';
import { claimSchema, createIssueSchema, restUpdateIssueSchema, z } from '@taskboard/core/schemas';

interface IssueParams { id: string }
interface ProjectParams { projectId: string }

// projectId comes from the route path, not the JSON body.
const createIssueBodySchema = createIssueSchema.omit({ projectId: true });

// One readable line per zod issue: "field: message; field: message".
const validationMessage = (error: z.ZodError): string =>
  error.issues.map(i => (i.path.length > 0 ? `${i.path.map(String).join('.')}: ` : '') + i.message).join('; ');

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
    // Session precedence: explicit body → x-taskboard-session header → the
    // project default → unbound. The store applies the same resolver; doing it
    // here lets the web gate reject tasks that would land unbound.
    const agentSession = String(req.headers['x-taskboard-session'] ?? '').trim() || null;
    const resolvedSession = resolveIssueSessionId(parsed.data.sessionId, agentSession, project.defaultSessionId);
    // Web task creation must bind an OpenCode session before saving. A project
    // default session satisfies this without an explicit body value.
    // CLI/MCP can still create unbound tasks intentionally and bind them on claim.
    if (actor === 'web' && resolvedSession === null) {
      return reply.code(400).send({ error: '创建任务前必须先选择一个 OpenCode 会话（sessionId 不能为空）' });
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
    return reply.code(201).send(store.createIssue({ ...body, projectId: req.params.projectId }, actor, agentSession));
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
      && !parsed.data.sessionId && !currentIssue.sessionId) {
      return reply.code(403).send({
        error: 'starting a task requires binding: claim/PATCH with sessionId and branch; confirm:true is not an approval credential (TASKBOARD_REQUIRE_SESSION)'
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

    const refs = await scanGitRefs(project.workspacePath);
    if (issue.worktreePath && refs.worktrees.some(w => w.path === issue.worktreePath)) {
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
        (other.worktreePath === created.path || other.branch === created.branch));
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

  app.post('/api/issues/:id/agent-events', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const eventSchema = z.object({ outcome: z.enum(['started', 'queued', 'retrying', 'succeeded', 'failed']), detail: z.string().trim().min(1).max(2000) });
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
    if (config.requireSession && !parsed.data.sessionId && !store.getIssue(req.params.id)?.sessionId
      && String(req.headers['x-taskboard-actor'] ?? '') !== 'web') {
      return reply.code(403).send({
        error: 'starting a task requires binding: claim/PATCH with sessionId and branch; confirm:true is not an approval credential (TASKBOARD_REQUIRE_SESSION)'
      });
    }
    return store.claimIssue(req.params.id, parsed.data.agent, parsed.data.ttlMinutes ?? 30, actor || parsed.data.agent, parsed.data.sessionId, parsed.data.branch);
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
