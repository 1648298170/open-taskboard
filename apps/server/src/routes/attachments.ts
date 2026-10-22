// T7-39 attachment routes. sqlite carries metadata rows only (core repo);
// file bodies live on disk under <dataDir>/attachments/<issueId>/, persisted
// atomically with metadata through Store.addAttachmentWithBody.
//
// Endpoints:
//   POST /api/issues/:id/attachments          multipart upload (1 file, ≤10MB)
//   GET  /api/issues/:id/attachments          metadata rows, oldest first
//   GET  /api/attachments/:attachmentId/download   body stream (RFC 5987 filename)
//   DELETE /api/attachments/:attachmentId          metadata row + on-disk body
//
// Readonly mode (TASKBOARD_READONLY=1): the global write-method hook in
// app.ts rejects the POST with 403 before this handler runs — uploads are
// covered by the same gate as every other mutating endpoint. Auth
// (TASKBOARD_TOKEN) likewise applies to all three via the /api/* hook.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { NotFoundError, Store, ValidationError } from '@taskboard/core';

interface IssueParams { id: string }
interface AttachmentParams { attachmentId: string }

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const attachmentsRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  await app.register(multipart, {
    attachFieldsToBody: false,
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 }
  });

  app.get('/api/issues/:id/attachments', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    if (!store.getIssue(req.params.id)) {
      return reply.code(404).send({ error: `issue not found: ${req.params.id}` });
    }
    return store.listAttachments(req.params.id);
  });

  app.post('/api/issues/:id/attachments', async (req: FastifyRequest<{ Params: IssueParams }>, reply) => {
    const issueId = req.params.id;
    if (!store.getIssue(issueId)) throw new NotFoundError(`issue not found: ${issueId}`);
    // Non-multipart bodies (wrong content-type) reject here → 400; an
    // over-limit file rejects at toBuffer() with the plugin's 413.
    let file: Awaited<ReturnType<typeof req.file>>;
    try {
      file = await req.file();
    } catch {
      throw new ValidationError('multipart/form-data body with one "file" part is required');
    }
    if (!file) throw new ValidationError('multipart/form-data body with one "file" part is required');
    // basename() neutralizes any client-side path; trim guards whitespace-only.
    const filename = basename(file.filename ?? '').trim();
    if (!filename) throw new ValidationError('filename must be non-empty');
    const body = await file.toBuffer();
    if (body.byteLength === 0) throw new ValidationError('attachment file must not be empty');
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    const attachment = store.addAttachmentWithBody(issueId, filename, body, actor);
    return reply.code(201).send(attachment);
  });

  app.get('/api/attachments/:attachmentId/download', async (req: FastifyRequest<{ Params: AttachmentParams }>, reply) => {
    const row = store.getAttachment(req.params.attachmentId);
    if (!row) throw new NotFoundError(`attachment not found: ${req.params.attachmentId}`);
    const path = store.attachmentPathFor(row.issueId, row.id, row.filename);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new NotFoundError(`attachment file missing: ${row.filename}`);
    }
    reply.header('content-type', 'application/octet-stream');
    // RFC 5987: filename* with UTF-8 percent-encoding carries non-ASCII names.
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    return reply.send(createReadStream(path));
  });

  app.delete('/api/attachments/:attachmentId', async (req: FastifyRequest<{ Params: AttachmentParams }>, reply) => {
    const actor = String(req.headers['x-taskboard-actor'] ?? '');
    store.deleteAttachment(req.params.attachmentId, actor);
    return reply.send({ ok: true });
  });
};

export default attachmentsRoutes;
