// /api/issues routes (list/create under a project, progress, get/patch/delete by id,
// archive, and the T7-34 claim/lease endpoints). Store arrives via plugin
// options. JSON bodies are validated with the shared zod schemas — no
// hand-rolled type assertions.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
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
    // T7-36 门禁的 create 侧：直接以 status:'done' 创建与 PATCH 置 done 同责，
    // 非 web 来源必须带 confirm 逃生舱（env 未设时零行为变化）。
    if (config.humanDone && parsed.data.status === 'done' &&
        String(req.headers['x-taskboard-actor'] ?? '') !== 'web' && parsed.data.confirm !== true) {
      return reply.code(403).send({ error: 'done requires human confirmation' });
    }
    // v0.4: in_review 评论门禁的 create 侧——创建即 in_review 时评论尚不可
    // 能存在，改用 confirm 逃生舱（与 done 同构）。
    if (config.reviewComment && parsed.data.status === 'in_review' &&
        String(req.headers['x-taskboard-actor'] ?? '') !== 'web' && parsed.data.confirm !== true) {
      return reply.code(403).send({ error: 'in_review requires a comment by this actor (先落评再交验)' });
    }
    // confirm 是门禁逃生舱字段——从 create body 剥离，不透传 Store
    const { confirm: _confirm, ...body } = parsed.data;
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
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
    // v0.4: 先落评再交验——非 web 来源置 in_review 时，执行者必须在任务上
    // 留过评论（工作与验证的书面痕迹）；默认开启，TASKBOARD_REVIEW_COMMENT=0 退出。
    // 仅拦状态流转（当前已 in_review 的非流转补丁不拦——已有人交验过，无信息损失）。
    if (config.reviewComment && parsed.data.status === 'in_review' &&
        store.getIssue(req.params.id)?.status !== 'in_review' &&
        String(req.headers['x-taskboard-actor'] ?? '') !== 'web' &&
        store.commentCountBy(req.params.id, String(req.headers['x-taskboard-actor'] ?? '')) === 0) {
      return reply.code(403).send({ error: 'in_review requires a comment by this actor (先落评再交验)' });
    }
    // T7-36: optional human final-review gate. With TASKBOARD_HUMAN_DONE=1, only
    // the web UI (x-taskboard-actor: 'web') may set status to done — CLI/MCP
    // agents must bring the task to in_review and wait for human confirmation
    // on the web board. The gate runs before the store call (cheap header
    // check first), so a gated request gets 403 even with a stale version.
    // Only direct status='done' patches are gated; other statuses and archive
    // are unaffected. Default (env unset/empty): zero behavior change.
    // T7-36 逃生舱（spec：默认仅 web）：用户在对话中确认后，agent 可传
    // confirm: true 代为设置。已知边界（本地优先工具）：actor 是客户端自报
    // 头，可被伪造——门禁约束的是守规矩的 stock cli/mcp 客户端，非恶意对手。
    if (config.humanDone && parsed.data.status === 'done' &&
        String(req.headers['x-taskboard-actor'] ?? '') !== 'web' && parsed.data.confirm !== true) {
      return reply.code(403).send({ error: 'done requires human confirmation' });
    }
    // confirm 是门禁逃生舱字段——从 patch 剥离，不透传 Store
    const { version, confirm, ...patch } = parsed.data;
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    return store.updateIssue(req.params.id, patch, version, actor);
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
  app.post('/api/issues/:id/claim', async (req: FastifyRequest<{ Params: IssueParams }>) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(validationMessage(parsed.error));
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    return store.claimIssue(req.params.id, parsed.data.agent, parsed.data.ttlMinutes ?? 30, actor || parsed.data.agent, parsed.data.sessionId);
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
