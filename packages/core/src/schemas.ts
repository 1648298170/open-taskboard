// Single source of truth for request input validation (REST / MCP / CLI).
// Enums come from ./types.js so runtime schemas and domain types never drift.
// Consumed via the "./schemas" subpath export 鈥?never re-exported from index.ts
// (the web bundle imports "./types" and must stay zod-free).
import { z } from 'zod';
import { PRIORITIES, STATUSES } from './types.js';

export { z };

// YYYY-MM-DD that is also a real calendar day: Date.parse rolls overflow
// dates forward ('2024-02-31' 鈫?Mar 2), so validate by round-tripping the
// exact y/m/d components through Date.UTC.
const isRealCalendarDate = (v: string): boolean => {
  const [y, m, d] = v.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const nullableDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealCalendarDate, 'must be a real calendar date (YYYY-MM-DD)')
  .nullable().optional();

export const createDirectorySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  workspacePath: z.string().optional(),
}).strict();

export const directoryPatchSchema = z.object({
  name: z.string().min(1).optional(),
  workspacePath: z.string().optional(),
}).strict();

export const createProjectSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    directoryId: z.string().min(1).optional(),
    // Deprecated compatibility inputs: only initialize a Directory when directoryId is absent.
    workspacePath: z.string().optional(),
    defaultSessionId: z.string().trim().min(1).nullable().optional(),
    labels: z.string().optional(),
    // v13: project default opencode session for new tasks.
    sessionId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const projectPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    defaultSessionId: z.string().trim().min(1).nullable().optional(),
    labels: z.string().optional(),
    // '' clears the project default; whitespace-only is rejected.
    sessionId: z.union([z.string().trim().min(1).max(200), z.literal('')]).optional(),
  })
  .strict();

export const createIssueSchema = z
  .object({
    projectId: z.string(),
    parentId: z.string().nullable().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    labels: z.string().optional(),
    branch: z.string().optional(),
    // T2-8: null creates as unbound ('' after the repo's ?? '' normalization).
    worktree: z.string().nullable().optional(),
    worktreePath: z.string().trim().max(2000).nullable().optional(),
    acceptanceCriteria: z.string().max(20000).optional(),
    reviewStatus: z.enum(['pending', 'approved', 'changes_requested']).optional(),
    reviewNotes: z.string().max(20000).optional(),
    // v0.4: opencode session binding 鈥?null/absent = unbound.
    // Deprecated compatibility input. The Project default Session is authoritative.
    sessionId: z.string().min(1).nullable().optional(),
    assignee: z.string().optional(),
    startDate: nullableDate,
    dueDate: nullableDate,
    // Deprecated compatibility field. The server does not treat client-supplied confirm as human approval.
    confirm: z.boolean().optional(),
  })
  .strict();

export const issuePatchSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    labels: z.string().optional(),
    branch: z.string().optional(),
    // T2-8: null clears (stored as '').
    worktree: z.string().nullable().optional(),
    worktreePath: z.string().trim().max(2000).nullable().optional(),
    acceptanceCriteria: z.string().max(20000).optional(),
    reviewStatus: z.enum(['pending', 'approved', 'changes_requested']).optional(),
    reviewNotes: z.string().max(20000).optional(),
    sessionId: z.string().min(1).nullable().optional(),
    assignee: z.string().optional(),
    parentId: z.string().nullable().optional(),
    startDate: nullableDate,
    dueDate: nullableDate,
  })
  .strict();

// REST PATCH keeps version optional (today's REST contract).
export const restUpdateIssueSchema = issuePatchSchema.extend({
  version: z.number().int().positive().optional(),
  // Required by the server for every real agent status transition; committed atomically with the status.
  statusNote: z.string().trim().min(1).max(10000).describe('Required for each actual agent status transition. Explain the reason, verification evidence, and unchecked items.').optional(),
  // Deprecated compatibility field. A client-supplied boolean is not proof of human approval.
  confirm: z.boolean().optional(),
});

// MCP update_issue requires version (optimistic-lock contract).
export const mcpUpdateIssueSchema = issuePatchSchema.extend({
  version: z.number().int().positive(),
  // Must accompany every real status transition; saved as a comment in the same transaction.
  statusNote: z.string().trim().min(1).max(10000).describe('Required for each actual agent status transition. Explain the reason, verification evidence, and unchecked items.').optional(),
  // T7-36 閫冪敓鑸憋紙涓?restUpdateIssueSchema 瀵归綈锛夛細浜哄伐纭鍚?agent 鍙紶
  confirm: z.boolean().optional(),
});

export const addCommentSchema = z
  .object({
    author: z.string().optional(),
    body: z.string().min(1),
  })
  .strict();

export const commentPatchSchema = z
  .object({
    body: z.string().min(1).optional(),
    status: z.enum(['pending', 'processing', 'processed']).optional(),
  })
  .strict();

export const addDependencySchema = z
  .object({
    dependsOnId: z.string().min(1),
  })
  .strict();

// T7-34: claim/heartbeat/release bodies. heartbeat reuses the whole shape
// (ttlMinutes renews with a fresh duration); release only needs the agent 鈥?
// a ttlMinutes in a release body is tolerated and ignored by the route.
export const claimSchema = z
  .object({
    agent: z.string().min(1),
    ttlMinutes: z.number().int().positive().max(1440).optional(),
    // 璁ら鍗崇粦瀹氾細缁戠┖浣嶄笉鎶㈢粦锛堝凡鏈夌粦瀹氳蹇界暐锛夛紝璇箟瑙?store.claimIssue銆?
    sessionId: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    // Deprecated compatibility field. The server never treats confirm:true as approval or a binding substitute.
    confirm: z.boolean().optional(),
  })
  .strict();

export type CreateDirectoryInput = z.infer<typeof createDirectorySchema>;
export type DirectoryPatchInput = z.infer<typeof directoryPatchSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateIssueInput = z.infer<typeof createIssueSchema>;
export type IssuePatchInput = z.infer<typeof issuePatchSchema>;
export type RestUpdateIssueInput = z.infer<typeof restUpdateIssueSchema>;
export type McpUpdateIssueInput = z.infer<typeof mcpUpdateIssueSchema>;
export type AddCommentInput = z.infer<typeof addCommentSchema>;
export type AddDependencyInput = z.infer<typeof addDependencySchema>;
export type ClaimInput = z.infer<typeof claimSchema>;

