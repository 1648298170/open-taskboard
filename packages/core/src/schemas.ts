// Single source of truth for request input validation (REST / MCP / CLI).
// Enums come from ./types.js so runtime schemas and domain types never drift.
// Consumed via the "./schemas" subpath export — never re-exported from index.ts
// (the web bundle imports "./types" and must stay zod-free).
import { z } from 'zod';
import { PRIORITIES, STATUSES } from './types.js';

export { z };

export const createProjectSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    workspacePath: z.string().optional(),
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
    assignee: z.string().optional(),
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
    assignee: z.string().optional(),
    parentId: z.string().nullable().optional(),
  })
  .strict();

// REST PATCH keeps version optional (today's REST contract).
export const restUpdateIssueSchema = issuePatchSchema.extend({
  version: z.number().int().positive().optional(),
});

// MCP update_issue requires version (optimistic-lock contract).
export const mcpUpdateIssueSchema = issuePatchSchema.extend({
  version: z.number().int().positive(),
});

export const addCommentSchema = z
  .object({
    author: z.string().optional(),
    body: z.string().min(1),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateIssueInput = z.infer<typeof createIssueSchema>;
export type IssuePatchInput = z.infer<typeof issuePatchSchema>;
export type RestUpdateIssueInput = z.infer<typeof restUpdateIssueSchema>;
export type McpUpdateIssueInput = z.infer<typeof mcpUpdateIssueSchema>;
export type AddCommentInput = z.infer<typeof addCommentSchema>;
