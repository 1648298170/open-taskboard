import { PRIORITIES, STATUSES } from '@taskboard/core';

// Single source of truth for the OpenAPI 3.1 document served at
// GET /api/openapi.json (routes/openapi.ts) and written verbatim to
// apps/server/openapi.json by scripts/write-openapi.mjs.
//
// Hand-written against the actual route plugins under src/routes/ — no
// codegen, no new dependencies. Types below cover exactly the OpenAPI
// subset this document uses, keeping the const fully typed.

export type JsonSchemaObject = {
  type?: string | string[];
  description?: string;
  format?: string;
  pattern?: string;
  enum?: Array<string | number | null>;
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  items?: JsonSchemaObject;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  allOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  $ref?: string;
};

export interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema: JsonSchemaObject;
  example?: unknown;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content: Record<string, { schema: JsonSchemaObject; example?: unknown }>;
}

export interface ResponseObject {
  description: string;
  content?: Record<string, { schema?: JsonSchemaObject; example?: unknown }>;
}

export type ResponseRef = { $ref: string };

export interface OperationObject {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters?: Array<ParameterObject | ParameterRef>;
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject | ResponseRef>;
  security?: Array<Record<string, string[]>>;
}

export type ParameterRef = { $ref: string };

export interface PathItemObject {
  summary?: string;
  parameters?: Array<ParameterObject | ParameterRef>;
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string; description?: string }[];
  security?: Array<Record<string, string[]>>;
  tags: { name: string; description: string }[];
  paths: Record<string, PathItemObject>;
  components: {
    schemas: Record<string, JsonSchemaObject>;
    responses: Record<string, ResponseObject>;
    parameters: Record<string, ParameterObject>;
    securitySchemes: Record<string, {
      type: string;
      scheme?: string;
      in?: string;
      name?: string;
      description: string;
    }>;
  };
}

const ISSUE_REF = { $ref: '#/components/schemas/Issue' } satisfies JsonSchemaObject;
const ERROR_REF = { $ref: '#/components/schemas/Error' } satisfies JsonSchemaObject;

const jsonResponse = (schema: JsonSchemaObject): { content: Record<string, { schema: JsonSchemaObject }> } => ({
  content: { 'application/json': { schema } }
});

const errorResponse = (description: string): ResponseObject => ({
  description,
  content: { 'application/json': { schema: ERROR_REF } }
});

/** Generic failures that any /api operation can produce (auth hook / error handler). */
const commonResponses = (mutating: boolean): Record<string, ResponseRef> => {
  const entries: Record<string, ResponseRef> = {
    401: { $ref: '#/components/responses/Unauthorized' },
    500: { $ref: '#/components/responses/InternalError' }
  };
  if (mutating) entries[403] = { $ref: '#/components/responses/Forbidden' };
  return entries;
};

export const openApiSpec: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'open-taskboard API',
    // Keep in sync with apps/server/package.json "version".
    version: '0.3.0',
    description:
      'Local-first task board REST API (Fastify + node:sqlite). Remote/non-loopback binds require one-time administrator setup and browser login using an HttpOnly, SameSite=Strict session cookie. ' +
      'TASKBOARD_TOKEN remains an optional compatibility credential for machine clients; browser users never need to paste a token. Loopback-only development can run without login. ' +
      'When TASKBOARD_READONLY=1, every mutating request (POST/PATCH/DELETE) is rejected with 403 before the handler runs. ' +
      'Writes may record the acting agent via the `x-taskboard-actor` header. ' +
      'Conventions: optimistic locking — PATCH /api/issues/{id} accepts an optional `version`; the MCP update_issue tool requires it.'
  },
  servers: [{ url: '/', description: 'This server (default http://127.0.0.1:47824; override via TASKBOARD_HOST/TASKBOARD_PORT)' }],
  security: [{ cookieAuth: [] }, { bearerAuth: [] }, { tokenQuery: [] }, {}],
  tags: [
    { name: 'auth', description: 'First-run administrator initialization and browser sessions' },
    { name: 'meta', description: 'Server metadata (enums, OpenAPI document)' },
    { name: 'events', description: 'Realtime SSE stream' },
    { name: 'projects', description: 'Project CRUD + git workspace views + stats' },
    { name: 'issues', description: 'Issue list/create/detail/update/delete + archive' },
    { name: 'comments', description: 'Issue comments' },
    { name: 'dependencies', description: 'Cross-issue dependencies and ready/next picks' },
    { name: 'attachments', description: 'Issue attachments (metadata in sqlite, bodies on disk)' },
    { name: 'search', description: 'Full-text search' }
  ],
  paths: {
    '/api/auth/status': {
      get: {
        operationId: 'getAuthStatus',
        summary: 'Read setup and current browser authentication state',
        tags: ['auth'],
        security: [],
        responses: {
          200: {
            description: 'Authentication status',
            ...jsonResponse({
              type: 'object',
              properties: {
                authRequired: { type: 'boolean' },
                initialized: { type: 'boolean' },
                authenticated: { type: 'boolean' },
                username: { type: ['string', 'null'] }
              },
              required: ['authRequired', 'initialized', 'authenticated', 'username'],
              additionalProperties: false
            })
          }
        }
      }
    },
    '/api/auth/setup': {
      post: {
        operationId: 'initializeAdmin',
        summary: 'Create the first administrator exactly once and start a browser session',
        tags: ['auth'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  username: { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-zA-Z0-9._-]+$' },
                  password: { type: 'string', minLength: 12, maxLength: 256 }
                },
                required: ['username', 'password'],
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          201: {
            description: 'Administrator created; session cookie set',
            ...jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean', const: true }, username: { type: 'string' } },
              required: ['ok', 'username'],
              additionalProperties: false
            })
          },
          400: { $ref: '#/components/responses/BadRequest' },
          409: {
            description: 'Administrator already initialized, or local no-login mode is enabled',
            ...jsonResponse(ERROR_REF)
          },
          500: { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/api/auth/login': {
      post: {
        operationId: 'loginAdmin',
        summary: 'Authenticate the administrator and start a browser session',
        tags: ['auth'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  username: { type: 'string', minLength: 3, maxLength: 64 },
                  password: { type: 'string', minLength: 1, maxLength: 256 }
                },
                required: ['username', 'password'],
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Authenticated; session cookie set',
            ...jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean', const: true }, username: { type: 'string' } },
              required: ['ok', 'username'],
              additionalProperties: false
            })
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          409: {
            description: 'Administrator has not been initialized',
            ...jsonResponse(ERROR_REF)
          },
          429: {
            description: 'Too many login attempts from this IP',
            ...jsonResponse(ERROR_REF)
          },
          500: { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/api/auth/logout': {
      post: {
        operationId: 'logoutAdmin',
        summary: 'Invalidate the current browser session',
        tags: ['auth'],
        security: [],
        responses: {
          200: {
            description: 'Session invalidated and cookie cleared',
            ...jsonResponse({
              type: 'object',
              properties: { ok: { type: 'boolean', const: true } },
              required: ['ok'],
              additionalProperties: false
            })
          }
        }
      }
    },
    '/api/meta': {
      get: {
        operationId: 'getMeta',
        summary: 'Status/priority enums',
        tags: ['meta'],
        responses: {
          200: {
            description: 'Canonical status and priority values',
            ...jsonResponse({ $ref: '#/components/schemas/Meta' })
          },
          ...commonResponses(false)
        }
      }
    },
    '/api/events': {
      get: {
        operationId: 'subscribeEvents',
        summary: 'SSE change stream',
        description:
          'Server-Sent Events stream (`text/event-stream`, kept open). Emits `hello` once with the current store ' +
          'revision, then one `change` event per store mutation carrying the StoreEvent JSON. ' +
          'When TASKBOARD_TOKEN is set, authenticate with `?token=<token>`.',
        tags: ['events'],
        parameters: [
          {
            name: 'token',
            in: 'query',
            required: false,
            description: 'Auth token for the stream (only needed when TASKBOARD_TOKEN is set)',
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'Event stream: `event: hello` → `{"revision":N}`; `event: change` → StoreEvent JSON',
            content: {
              'text/event-stream': {
                schema: { type: 'string' },
                example: 'event: change\ndata: {"type":"issue.updated","payload":{"id":"abcd1234"},"revision":42,"at":"2026-01-01T00:00:00.000Z"}\n\n'
              }
            }
          },
          401: { $ref: '#/components/responses/Unauthorized' }
        }
      }
    },
    '/api/settings': {
      summary: 'Read and update global application defaults',
      get: {
        operationId: 'getAppSettings', summary: 'Read global application settings', tags: ['settings'],
        responses: { 200: { description: 'Global settings', ...jsonResponse({ $ref: '#/components/schemas/AppSettings' }) }, ...commonResponses(false) }
      },
      put: {
        operationId: 'updateAppSettings', summary: 'Update global application defaults', tags: ['settings'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { defaultWorkspacePath: { type: 'string' }, defaultOpenCodeServerUrl: { type: 'string' } }, additionalProperties: false } } } },
        responses: { 200: { description: 'Updated settings', ...jsonResponse({ $ref: '#/components/schemas/AppSettings' }) }, 400: { $ref: '#/components/responses/BadRequest' }, ...commonResponses(true) }
      }
    },
    '/api/directories/browse': {
      summary: 'Browse directories on a configured OpenCode server',
      get: {
        operationId: 'browseWorkspaceDirectories',
        summary: 'List child directories from the OpenCode server filesystem',
        description: 'This endpoint browses the filesystem that belongs to the supplied OpenCode Server, not the browser host or Taskboard container. Omit path to start at the OpenCode server current directory. At Windows drive roots, drives lists accessible drive letters.',
        tags: ['directories'],
        parameters: [
          { name: 'serverUrl', in: 'query', required: true, schema: { type: 'string', format: 'uri' } },
          { name: 'path', in: 'query', required: false, schema: { type: 'string' }, description: 'Absolute directory path on the OpenCode server; omitted uses its current path' }
        ],
        responses: {
          200: {
            description: 'Current directory and its direct child directories',
            ...jsonResponse({
              type: 'object',
              properties: {
                path: { type: 'string' },
                parentPath: { type: ['string', 'null'] },
                entries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { name: { type: 'string' }, path: { type: 'string' } },
                    required: ['name', 'path'],
                    additionalProperties: false
                  }
                },
                drives: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { name: { type: 'string' }, path: { type: 'string' } },
                    required: ['name', 'path'],
                    additionalProperties: false
                  }
                }
              },
              required: ['path', 'parentPath', 'entries', 'drives'],
              additionalProperties: false
            })
          },
          400: { $ref: '#/components/responses/BadRequest' },
          502: { description: 'OpenCode server unavailable or does not support directory listing', ...jsonResponse({ $ref: '#/components/schemas/Error' }) },
          ...commonResponses(false)
        }
      }
    },
    '/api/directories': {
      summary: 'List and create workspace directories',
      get: {
        operationId: 'listDirectories',
        summary: 'List workspace directories',
        tags: ['directories'],
        responses: {
          200: { description: 'Workspace directories', ...jsonResponse({ type: 'array', items: { $ref: '#/components/schemas/WorkspaceDirectory' } }) },
          ...commonResponses(false)
        }
      },
      post: {
        operationId: 'createDirectory',
        summary: 'Create a workspace directory with an optional default workspace path',
        tags: ['directories'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateDirectoryRequest' } } } },
        responses: {
          201: { description: 'Created directory', ...jsonResponse({ $ref: '#/components/schemas/WorkspaceDirectory' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          ...commonResponses(true)
        }
      }
    },
    '/api/directories/{directoryId}': {
      summary: 'Update or delete a workspace directory',
      parameters: [{ name: 'directoryId', in: 'path', required: true, schema: { type: 'string' } }],
      patch: {
        operationId: 'updateDirectory',
        summary: 'Update the Directory route inherited by every Project',
        tags: ['directories'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PatchDirectoryRequest' } } } },
        responses: {
          200: { description: 'Updated directory', ...jsonResponse({ $ref: '#/components/schemas/WorkspaceDirectory' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          ...commonResponses(true)
        }
      },
      delete: {
        operationId: 'deleteDirectory',
        summary: 'Delete a directory, optionally cascading its projects and tasks',
        tags: ['directories'],
        parameters: [
          { name: 'cascade', in: 'query', required: false, schema: { type: 'boolean' }, description: 'true/1 deletes all projects, tasks, comments and attachments under the directory' }
        ],
        responses: {
          200: { description: 'Deleted directory', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/directories/{directoryId}/opencode-status': {
      summary: 'Read OpenCode server and Project Session runtime status for a Directory',
      parameters: [{ name: 'directoryId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getDirectoryOpenCodeStatus',
        summary: 'Read the configured Server status and live runtime state of each Project default Session',
        tags: ['directories'],
        responses: {
          200: { description: 'Directory OpenCode status and per-Project Session state', ...jsonResponse({ type: 'object', additionalProperties: true }) },
          404: { $ref: '#/components/responses/NotFound' },
          502: { description: 'OpenCode server unavailable', ...jsonResponse({ $ref: '#/components/schemas/Error' }) },
          ...commonResponses(false)
        }
      }
    },
    '/api/directories/{directoryId}/opencode-sessions': {
      summary: 'List or create OpenCode sessions in a workspace directory',
      parameters: [{ name: 'directoryId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'listDirectoryOpenCodeSessions',
        summary: 'List OpenCode sessions using the workspace path and Server URL configured on the Directory',
        tags: ['directories'],
        responses: {
          200: { description: 'Sessions in the directory', ...jsonResponse({ type: 'object', additionalProperties: true }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          502: { description: 'OpenCode server error', ...jsonResponse({ $ref: '#/components/schemas/Error' }) },
          ...commonResponses(false)
        }
      },
      post: {
        operationId: 'createDirectoryOpenCodeSession',
        summary: 'Create an OpenCode session in the directory path',
        tags: ['directories'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['title'], additionalProperties: false } } } },
        responses: {
          201: { description: 'Created session', ...jsonResponse({ type: 'object', additionalProperties: true }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          502: { description: 'OpenCode server error', ...jsonResponse({ $ref: '#/components/schemas/Error' }) },
          ...commonResponses(true)
        }
      }
    },
    '/api/projects': {
      summary: 'List / create projects',
      get: {
        operationId: 'listProjects',
        summary: 'List all projects',
        tags: ['projects'],
        responses: {
          200: { description: 'All projects, oldest first', ...jsonResponse({ type: 'array', items: { $ref: '#/components/schemas/Project' } }) },
          ...commonResponses(false)
        }
      },
      post: {
        operationId: 'createProject',
        summary: 'Create a project under a Directory; its default Session is validated against the Directory workspace and server',
        tags: ['projects'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateProjectRequest' } } }
        },
        responses: {
          201: { description: 'Created project', ...jsonResponse({ $ref: '#/components/schemas/Project' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          409: { $ref: '#/components/responses/Conflict' },
          ...commonResponses(true)
        }
      }
    },
    '/api/projects/{projectId}': {
      summary: 'Show / delete a project',
      parameters: [{ $ref: '#/components/parameters/ProjectId' }],
      get: {
        operationId: 'getProject',
        summary: 'Show a project',
        tags: ['projects'],
        responses: {
          200: { description: 'The project', ...jsonResponse({ $ref: '#/components/schemas/Project' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      },
      patch: {
        operationId: 'patchProject',
        summary: 'Update project configuration; a default Session is validated only against its owning Directory route',
        tags: ['projects'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PatchProjectRequest' } } }
        },
        responses: {
          200: { description: 'Updated project', ...jsonResponse({ $ref: '#/components/schemas/Project' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      },
      delete: {
        operationId: 'deleteProject',
        summary: 'Delete a project and all its issues/comments',
        tags: ['projects'],
        responses: {
          200: { description: 'Deleted', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/opencode/sessions': {
      summary: 'OpenCode sessions for an arbitrary server URL',
      get: {
        operationId: 'listOpenCodeSessions',
        summary: 'List sessions from an OpenCode v1 server (create-project flow)',
        description:
          'Stateless variant used before a project exists. `url` is optional: when blank the server resolves a default ' +
          'in this order — `TASKBOARD_OPENCODE_URL` → the newest project wakeChannel → `http://127.0.0.1:4096`. ' +
          'An explicit `url` wins and must be an http(s) origin. When `workspacePath` is provided, only sessions ' +
          'with the same directory are returned.',
        tags: ['projects'],
        parameters: [
          {
            name: 'url',
            in: 'query',
            required: false,
            description: 'OpenCode server origin, e.g. http://127.0.0.1:4096; blank → default resolution order',
            schema: { type: 'string' }
          },
          {
            name: 'workspacePath',
            in: 'query',
            required: false,
            description: 'Only return sessions whose directory matches this workspace',
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: {
            description: 'Compatible OpenCode sessions',
            ...jsonResponse({
              type: 'object',
              properties: {
                sessions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      directory: { type: 'string' },
                      updatedAt: { type: ['integer', 'null'] }
                    },
                    required: ['id', 'title', 'directory', 'updatedAt'],
                    additionalProperties: false
                  }
                },
                workspacePath: { type: 'string' },
                serverUrl: { type: 'string' }
              },
              required: ['sessions', 'workspacePath', 'serverUrl'],
              additionalProperties: false
            })
          },
          400: { $ref: '#/components/responses/BadRequest' },
          502: {
            description: 'OpenCode server is unreachable or returned an invalid response',
            ...jsonResponse({ $ref: '#/components/schemas/Error' })
          },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/opencode-sessions': {
      summary: 'OpenCode sessions available for task binding',
      get: {
        operationId: 'listProjectOpenCodeSessions',
        summary: 'List sessions from the configured OpenCode v1 server',
        description: 'Uses the project wakeChannel as the OpenCode server origin. If workspacePath is configured, only sessions with the same directory are returned.',
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          200: {
            description: 'Compatible OpenCode sessions',
            ...jsonResponse({
              type: 'object',
              properties: {
                sessions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      directory: { type: 'string' },
                      updatedAt: { type: ['integer', 'null'] }
                    },
                    required: ['id', 'title', 'directory', 'updatedAt'],
                    additionalProperties: false
                  }
                },
                workspacePath: { type: 'string' },
                serverUrl: { type: 'string' }
              },
              required: ['sessions', 'workspacePath', 'serverUrl'],
              additionalProperties: false
            })
          },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          502: {
            description: 'OpenCode server is unreachable or returned an invalid response',
            ...jsonResponse({ $ref: '#/components/schemas/Error' })
          },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/git-refs': {
      summary: 'Branches + worktrees of the project workspace',
      get: {
        operationId: 'listGitRefs',
        summary: 'Git branches and worktrees',
        description:
          'Scans the project workspacePath with git. Any git failure (no workspace, not a repo, git missing, timeout) ' +
          'collapses to empty arrays — this endpoint never 500s for git reasons.',
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          200: { description: 'Branch names and worktrees', ...jsonResponse({ $ref: '#/components/schemas/GitRefs' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/commits': {
      summary: 'Recent commits of the project workspace',
      get: {
        operationId: 'listCommits',
        summary: 'Recent commits (newest first, max 5)',
        description:
          'If `ref` matches a worktree NAME, commits come from that worktree checkout at HEAD; anything else is treated ' +
          'as a git ref inside workspacePath. Empty/unset ref or no workspace → `{ "commits": [] }`. Git failures → empty list.',
        tags: ['projects'],
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          {
            name: 'ref',
            in: 'query',
            required: false,
            description: 'Branch name, worktree name, or any git ref',
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: { description: 'Commit list', ...jsonResponse({ $ref: '#/components/schemas/CommitList' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/stats': {
      summary: 'Project stats panel aggregate (concurrent feature, documented as-is)',
      get: {
        operationId: 'getProjectStats',
        summary: 'Weekly done counts, cycle time, actor and status breakdowns',
        description:
          'Stats feature landing in parallel — behavior as implemented: `weeks` falls back to 8 when missing/non-numeric; ' +
          'the store clamps the final range to 1..26 weeks (0/−3 → 1, 99 → 26).',
        tags: ['projects'],
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          {
            name: 'weeks',
            in: 'query',
            required: false,
            description: 'Window length in weeks (clamped to 1..26; default 8)',
            schema: { type: 'integer', minimum: 1, default: 8 }
          }
        ],
        responses: {
          200: { description: 'Aggregated stats', ...jsonResponse({ $ref: '#/components/schemas/Stats' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/issues': {
      summary: 'List / create issues under a project',
      get: {
        operationId: 'listIssues',
        summary: 'List issues with filters',
        description:
          'Archived rows are excluded by default. `archived=only` returns just archived rows; `archived=all` returns ' +
          'everything. `parentId=null` (literal string) selects top-level issues only. `includeDone=false` drops done rows. ' +
          'Order: priority (urgent→low), then creation.',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          {
            name: 'status',
            in: 'query',
            required: false,
            description: 'Exact status filter (invalid value → 400)',
            schema: { $ref: '#/components/schemas/Status' }
          },
          {
            name: 'parentId',
            in: 'query',
            required: false,
            description: 'Exact parent issue id; the literal string "null" means top-level only',
            schema: { type: 'string' }
          },
          {
            name: 'includeDone',
            in: 'query',
            required: false,
            description: 'false excludes done issues (default true)',
            schema: { type: 'string', enum: ['true', 'false'], default: 'true' }
          },
          {
            name: 'archived',
            in: 'query',
            required: false,
            description: "'only' | 'all'; absent → archived rows excluded",
            schema: { type: 'string', enum: ['only', 'all'] }
          }
        ],
        responses: {
          200: { description: 'Matching issues', ...jsonResponse({ type: 'array', items: ISSUE_REF }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      },
      post: {
        operationId: 'createIssue',
        summary: 'Create an issue',
        description:
          'projectId comes from the path, never the body. Parent rules: max two levels (parent must be top-level, same ' +
          'project) — violations → 400; unknown parent/project → 404.',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/Actor' },
          { $ref: '#/components/parameters/Session' }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateIssueRequest' } } }
        },
        responses: {
          201: { description: 'Created issue', ...jsonResponse(ISSUE_REF) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/projects/{projectId}/progress': {
      summary: 'Progress aggregate',
      get: {
        operationId: 'getProgress',
        summary: 'Done/total counters (top-level issues count as one unit each)',
        tags: ['issues'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          200: { description: 'Progress counters', ...jsonResponse({ $ref: '#/components/schemas/Progress' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/dependencies': {
      summary: 'Project dependency edge list',
      get: {
        operationId: 'listDependencies',
        summary: 'All dependency edges of a project',
        tags: ['dependencies'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          200: {
            description: 'Edges (issueId is blocked by dependsOnId)',
            ...jsonResponse({ type: 'array', items: { $ref: '#/components/schemas/DependencyEdge' } })
          },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/ready': {
      summary: 'Issues ready to work on',
      get: {
        operationId: 'listReadyIssues',
        summary: 'Not-done issues whose dependencies are all done',
        description: 'Standard listIssues priority order. `assignee` filters to that exact assignee.',
        tags: ['dependencies'],
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          {
            name: 'assignee',
            in: 'query',
            required: false,
            description: 'Only issues with this exact assignee',
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: { description: 'Ready issues', ...jsonResponse({ type: 'array', items: ISSUE_REF }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/projects/{projectId}/next': {
      summary: 'The single best next task',
      get: {
        operationId: 'getNextIssue',
        summary: 'First ready issue, or null',
        tags: ['dependencies'],
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          {
            name: 'assignee',
            in: 'query',
            required: false,
            description: 'Only issues with this exact assignee',
            schema: { type: 'string' }
          }
        ],
        responses: {
          200: { description: 'Next issue (null when nothing is ready)', ...jsonResponse({ $ref: '#/components/schemas/NextIssue' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/issues/{id}': {
      summary: 'Show / update / delete an issue',
      parameters: [{ $ref: '#/components/parameters/IssueId' }],
      get: {
        operationId: 'getIssue',
        summary: 'Issue detail (children, comments, activities, dependencies)',
        tags: ['issues'],
        parameters: [{ $ref: '#/components/parameters/IssueId' }],
        responses: {
          200: { description: 'Issue detail', ...jsonResponse({ $ref: '#/components/schemas/IssueDetail' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      },
      patch: {
        operationId: 'updateIssue',
        summary: 'Patch an issue (optimistic lock via optional version)',
        description:
          'Send the `version` from your last read to guard against concurrent overwrites — a mismatch → 409 with a ' +
          're-read-and-retry message. REST keeps version optional (the MCP tool requires it).',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateIssueRequest' } } }
        },
        responses: {
          200: { description: 'Updated issue', ...jsonResponse(ISSUE_REF) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          ...commonResponses(true)
        }
      },
      delete: {
        operationId: 'deleteIssue',
        summary: 'Delete an issue (whole subtree, its comments and edges)',
        tags: ['issues'],
        parameters: [{ $ref: '#/components/parameters/IssueId' }],
        responses: {
          200: { description: 'Deleted', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/opencode-state': {
      summary: 'Recover the current OpenCode Session state for an issue',
      get: {
        operationId: 'getIssueOpenCodeState',
        summary: 'Read authoritative Session status after reconnect or Taskboard restart',
        tags: ['issues'],
        parameters: [{ $ref: '#/components/parameters/IssueId' }],
        responses: {
          200: { description: 'OpenCode Session snapshot', ...jsonResponse({ type: 'object', additionalProperties: true }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          502: { description: 'OpenCode server unavailable or Session cannot be recovered', ...jsonResponse({ $ref: '#/components/schemas/Error' }) },
          ...commonResponses(false)
        }
      }
    },
    '/api/issues/{id}/opencode-abort': {
      summary: 'Cancel the agent currently executing in the issue-bound OpenCode Session',
      post: {
        operationId: 'abortIssueOpenCodeSession',
        summary: 'Send an abort request to the owning OpenCode server',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        responses: {
          200: { description: 'Cancellation request accepted', ...jsonResponse({ type: 'object', additionalProperties: true }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          502: { description: 'OpenCode server rejected or could not process cancellation', ...jsonResponse({ $ref: '#/components/schemas/Error' }) },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/opencode-events': {
      summary: 'Subscribe to live events for the issue-bound OpenCode Session',
      get: {
        operationId: 'subscribeIssueOpenCodeEvents',
        summary: 'Proxy OpenCode SSE events filtered to the bound Session; reconnect then refresh opencode-state',
        tags: ['issues'],
        parameters: [{ $ref: '#/components/parameters/IssueId' }],
        responses: {
          200: {
            description: 'Server-sent events: ready, opencode, and upstream-error',
            content: { 'text/event-stream': { schema: { type: 'string' } } }
          },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          502: { description: 'OpenCode event stream unavailable', ...jsonResponse({ $ref: '#/components/schemas/Error' }) },
          ...commonResponses(false)
        }
      }
    },
    '/api/issues/{id}/archive': {
      summary: 'Archive an issue',
      post: {
        operationId: 'archiveIssue',
        summary: 'Archive (sets archivedAt; hides from default lists)',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        responses: {
          200: { description: 'Archived', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/unarchive': {
      summary: 'Unarchive an issue',
      post: {
        operationId: 'unarchiveIssue',
        summary: 'Unarchive (clears archivedAt)',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        responses: {
          200: { description: 'Unarchived', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/claim': {
      summary: 'Claim an issue (exclusive lease)',
      post: {
        operationId: 'claimIssue',
        summary: 'Take or renew the exclusive lease',
        description:
          'T7-34: re-entrant for the same agent (a second claim renews). Another agent\'s ACTIVE lease → 409; ' +
          'an expired lease is fair game. Row mutation: bumps version + updated_at and logs a claimed activity.',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimRequest' } } }
        },
        responses: {
          200: { description: 'The claimed issue', ...jsonResponse(ISSUE_REF) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/heartbeat': {
      summary: 'Renew the lease of an issue you hold',
      post: {
        operationId: 'heartbeatIssue',
        summary: 'Renew the caller\'s lease (heartbeat)',
        description:
          'T7-34: extends lease_expires_at by ttlMinutes (default 30). Pure lease op — no version bump, no ' +
          'updated_at touch, no activity; still emits issue.updated. Non-holder or expired lease → 409.',
        tags: ['issues'],
        parameters: [{ $ref: '#/components/parameters/IssueId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimRequest' } } }
        },
        responses: {
          200: { description: 'The issue with the renewed lease', ...jsonResponse(ISSUE_REF) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/release': {
      summary: 'Release the lease of an issue',
      post: {
        operationId: 'releaseIssue',
        summary: 'Give the lease back',
        description:
          'T7-34: clearing an ACTIVE claim bumps version + updated_at and logs a released activity; releasing ' +
          'an unclaimed or expired issue is an idempotent no-op (200, no side effects). Another holder\'s ' +
          'ACTIVE claim → 409. ttlMinutes in the body is tolerated and ignored.',
        tags: ['issues'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimRequest' } } }
        },
        responses: {
          200: { description: 'The released issue', ...jsonResponse(ISSUE_REF) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/comments': {
      summary: 'List / add comments on an issue',
      get: {
        operationId: 'listComments',
        summary: 'Comments, oldest first',
        tags: ['comments'],
        parameters: [{ $ref: '#/components/parameters/IssueId' }],
        responses: {
          200: { description: 'Comments', ...jsonResponse({ type: 'array', items: { $ref: '#/components/schemas/Comment' } }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      },
      post: {
        operationId: 'addComment',
        summary: 'Add a comment',
        tags: ['comments'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AddCommentRequest' } } }
        },
        responses: {
          201: { description: 'Created comment', ...jsonResponse({ $ref: '#/components/schemas/Comment' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/comments/{commentId}': {
      summary: 'Delete a comment',
      delete: {
        operationId: 'deleteComment',
        summary: 'Delete a comment (FTS index cleaned, activity logged)',
        tags: ['comments'],
        parameters: [{ $ref: '#/components/parameters/CommentId' }],
        responses: {
          200: { description: 'Deleted', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/dependencies': {
      summary: 'Add a dependency edge',
      post: {
        operationId: 'addDependency',
        summary: 'Mark {id} as blocked by dependsOnId',
        description:
          'Same project only; self-dependency and cycles → 400; unknown issue ids → 404; duplicate edge → 409 (reserved).',
        tags: ['dependencies'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AddDependencyRequest' } } }
        },
        responses: {
          201: { description: 'Edge added', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/dependencies/{dependsOnId}': {
      summary: 'Remove a dependency edge',
      delete: {
        operationId: 'removeDependency',
        summary: 'Remove the edge {id} → blocked by {dependsOnId}',
        description: 'Unknown issue ids → 404; a non-existent edge → 400.',
        tags: ['dependencies'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/DependsOnId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        responses: {
          200: { description: 'Edge removed', ...jsonResponse({ $ref: '#/components/schemas/Ok' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(true)
        }
      }
    },
    '/api/issues/{id}/attachments': {
      summary: 'List / upload attachments of an issue',
      get: {
        operationId: 'listAttachments',
        summary: 'Attachment metadata rows, oldest first',
        description: 'GET /api/issues/{id} (IssueDetail) carries the same array under `attachments`.',
        tags: ['attachments'],
        parameters: [{ $ref: '#/components/parameters/IssueId' }],
        responses: {
          200: { description: 'Attachments', ...jsonResponse({ type: 'array', items: { $ref: '#/components/schemas/Attachment' } }) },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      },
      post: {
        operationId: 'uploadAttachment',
        summary: 'Upload one file (multipart/form-data, ≤10MB)',
        description:
          'Exactly one `file` part; empty files and blank filenames → 400; over-limit bodies → 413. ' +
          'The metadata row is stored in sqlite, the body on disk under <dataDir>/attachments/<issueId>/. ' +
          'Read-only mode (TASKBOARD_READONLY=1) rejects the POST with 403 before the handler runs.',
        tags: ['attachments'],
        parameters: [
          { $ref: '#/components/parameters/IssueId' },
          { $ref: '#/components/parameters/Actor' }
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary', description: 'The attachment body (filename becomes the record name)' } },
                required: ['file'],
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          201: { description: 'Recorded attachment', ...jsonResponse({ $ref: '#/components/schemas/Attachment' }) },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          413: { description: 'File exceeds the 10MB limit', ...jsonResponse(ERROR_REF) },
          ...commonResponses(true)
        }
      }
    },
    '/api/attachments/{attachmentId}/download': {
      summary: 'Download one attachment body',
      get: {
        operationId: 'downloadAttachment',
        summary: 'Stream the file as application/octet-stream',
        description:
          'RFC 5987 content-disposition (`filename*=UTF-8\'\'…`) preserves non-ASCII names. ' +
          'Unknown row or missing on-disk file → 404.',
        tags: ['attachments'],
        parameters: [{
          name: 'attachmentId',
          in: 'path',
          required: true,
          description: 'Attachment id',
          schema: { type: 'string' }
        }],
        responses: {
          200: {
            description: 'The file bytes',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
          },
          404: { $ref: '#/components/responses/NotFound' },
          ...commonResponses(false)
        }
      }
    },
    '/api/backup': {
      summary: 'Create a backup snapshot now',
      post: {
        operationId: 'createBackup',
        summary: 'Write a VACUUM INTO snapshot under <dataDir>/backups/',
        description:
          'Manual on-demand snapshot — ignores TASKBOARD_BACKUPS=0 (an explicit request always backs up). ' +
          'TASKBOARD_READONLY=1 still rejects it: a snapshot is a disk write.',
        tags: ['projects'],
        responses: {
          200: { description: 'Snapshot written', ...jsonResponse({ $ref: '#/components/schemas/BackupCreated' }) },
          500: { $ref: '#/components/responses/InternalError' },
          ...commonResponses(true)
        }
      }
    },
    '/api/search': {
      summary: 'Full-text search',
      get: {
        operationId: 'search',
        summary: 'Search issue titles, descriptions and comment bodies',
        description:
          'Trigram FTS for queries ≥3 chars (a comment hit maps to its parent issue); shorter queries fall back to a ' +
          'case-insensitive LIKE scan over title/description. Archived issues are excluded.',
        tags: ['search'],
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            description: 'Search phrase (min 1 char after trim; missing/blank → 400)',
            schema: { type: 'string', minLength: 1 },
            example: 'login'
          }
        ],
        responses: {
          200: { description: 'Matching issues', ...jsonResponse({ type: 'array', items: ISSUE_REF }) },
          400: { $ref: '#/components/responses/BadRequest' },
          ...commonResponses(false)
        }
      }
    },
    '/api/openapi.json': {
      summary: 'This document',
      get: {
        operationId: 'getOpenapi',
        summary: 'The OpenAPI 3.1 document describing this API',
        tags: ['meta'],
        responses: {
          200: {
            description: 'OpenAPI 3.1 document',
            content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
          },
          401: { $ref: '#/components/responses/Unauthorized' }
        }
      }
    }
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        description: 'Every non-2xx JSON body: { "error": "<message>" }',
        properties: { error: { type: 'string' } },
        required: ['error'],
        additionalProperties: false
      },
      Status: {
        type: 'string',
        description: 'Issue lifecycle status (strict order: todo → in_progress → in_review → done)',
        enum: [...STATUSES]
      },
      Priority: {
        type: 'string',
        description: 'Issue priority (list order: urgent first)',
        enum: [...PRIORITIES]
      },
      AppSettings: {
        type: 'object', description: 'Persistent global application defaults',
        properties: {
          defaultWorkspacePath: { type: 'string', description: 'Default path prefilled when creating workspace directories' },
          defaultOpenCodeServerUrl: { type: 'string', description: 'Default OpenCode Server URL prefilled when creating workspace directories' }
        },
        required: ['defaultWorkspacePath', 'defaultOpenCodeServerUrl'], additionalProperties: false
      },
      WorkspaceDirectory: {
        type: 'object',
        description: 'Single source of truth for filesystem workspace and OpenCode Server URL inherited by every Project in this Directory',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: 'Sidebar grouping name; not a filesystem path' },
          workspacePath: { type: 'string', description: 'Filesystem workspace inherited by all Projects in this Directory' },
          serverUrl: { type: 'string', description: 'OpenCode Server URL inherited by all Projects in this Directory' },
          createdAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'name', 'workspacePath', 'serverUrl', 'createdAt'],
        additionalProperties: false
      },
      Project: {
        type: 'object',
        description: 'A board project',
        properties: {
          id: { type: 'string', description: 'Client-supplied id or a generated 8-char id' },
          name: { type: 'string' },
          directoryId: { type: ['string', 'null'] },
          defaultSessionId: { type: ['string', 'null'], description: 'Optional default session preselected for new tasks' },
          workspacePath: { type: 'string', description: 'Computed from the owning Directory; not stored on Project' },
          wakeChannel: { type: 'string', description: 'Computed from the owning Directory; not stored on Project' },
          labels: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'name', 'directoryId', 'defaultSessionId', 'workspacePath', 'wakeChannel', 'labels', 'createdAt'],
        additionalProperties: false
      },
      Issue: {
        type: 'object',
        description: 'A task (top-level or child; max two levels)',
        properties: {
          id: { type: 'string' },
          projectId: { type: 'string' },
          parentId: { type: ['string', 'null'], description: 'null = top-level issue' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { $ref: '#/components/schemas/Status' },
          priority: { $ref: '#/components/schemas/Priority' },
          labels: { type: 'string', description: 'Comma-separated free-form labels' },
          branch: { type: 'string', description: 'Bound git branch; empty string = unbound' },
          worktree: { type: 'string', description: 'Bound git worktree name; empty string = unbound' },
          sessionId: { type: ['string', 'null'], description: 'Inherited from Project.defaultSessionId; task-level Session bindings are not stored' },
          archivedAt: { type: ['string', 'null'], format: 'date-time', description: 'Archive timestamp; null = not archived' },
          claimedBy: { type: 'string', description: 'Exclusive claim holder (T7-34); empty string = unclaimed' },
          leaseExpiresAt: { type: ['string', 'null'], format: 'date-time', description: 'Claim lease deadline; null or past = no active claim' },
          assignee: { type: 'string' },
          version: { type: 'integer', minimum: 1, description: 'Optimistic-lock version; include it in PATCH to guard concurrent writes' },
          startDate: { type: ['string', 'null'], format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          dueDate: { type: ['string', 'null'], format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        },
        required: [
          'id', 'projectId', 'parentId', 'title', 'description', 'status', 'priority', 'labels',
          'branch', 'worktree', 'sessionId', 'archivedAt', 'claimedBy', 'leaseExpiresAt', 'assignee', 'version',
          'startDate', 'dueDate', 'createdAt', 'updatedAt'
        ],
        additionalProperties: false
      },
      IssueDetail: {
        description: 'GET /api/issues/{id} shape: Issue plus relations',
        allOf: [
          { $ref: '#/components/schemas/Issue' },
          {
            type: 'object',
            properties: {
              children: { type: 'array', items: ISSUE_REF, description: 'Direct children ([] when this issue is itself a child)' },
              comments: { type: 'array', items: { $ref: '#/components/schemas/Comment' } },
              activities: { type: 'array', items: { $ref: '#/components/schemas/Activity' } },
              attachments: { type: 'array', items: { $ref: '#/components/schemas/Attachment' }, description: 'Attachment metadata, oldest first' },
              blockedBy: { type: 'array', items: { type: 'string' }, description: 'Issue ids this one is blocked by' },
              blocks: { type: 'array', items: { type: 'string' }, description: 'Issue ids blocked by this one' }
            },
            required: ['children', 'comments', 'activities', 'attachments', 'blockedBy', 'blocks']
          }
        ]
      },
      Comment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          issueId: { type: 'string' },
          author: { type: 'string', description: 'Falls back to the actor header/empty string' },
          body: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'issueId', 'author', 'body', 'createdAt'],
        additionalProperties: false
      },
      Activity: {
        type: 'object',
        description: 'Audit trail entry (created/updated/dependency-added/…)',
        properties: {
          id: { type: 'string' },
          issueId: { type: 'string' },
          actor: { type: 'string' },
          action: { type: 'string', description: 'e.g. created, updated, dependency-added' },
          detail: { type: 'string', description: 'Changed keys joined by ","; status changes include the transition' },
          createdAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'issueId', 'actor', 'action', 'detail', 'createdAt'],
        additionalProperties: false
      },
      DependencyEdge: {
        type: 'object',
        description: 'issueId is blocked by dependsOnId',
        properties: {
          issueId: { type: 'string' },
          dependsOnId: { type: 'string' }
        },
        required: ['issueId', 'dependsOnId'],
        additionalProperties: false
      },
      Progress: {
        type: 'object',
        description: 'Progress counters — one top-level issue = one unit',
        properties: {
          total: { type: 'integer' },
          done: { type: 'integer' },
          topTotal: { type: 'integer', description: 'Top-level issues' },
          topDone: { type: 'integer', description: 'Done top-level issues' },
          weightedDone: { type: 'integer', description: 'Done units under top-level weighting' },
          weightedTotal: { type: 'integer', description: 'Total units under top-level weighting' }
        },
        required: ['total', 'done', 'topTotal', 'topDone', 'weightedDone', 'weightedTotal'],
        additionalProperties: false
      },
      Stats: {
        type: 'object',
        description: 'Project stats panel (concurrent feature, documented as-is)',
        properties: {
          weeklyDone: {
            type: 'array',
            description: 'Done counts per week (Mondays, zero-filled, oldest → newest)',
            items: {
              type: 'object',
              properties: {
                weekStart: { type: 'string', format: 'date', description: 'Monday of that week (YYYY-MM-DD)' },
                count: { type: 'integer' }
              },
              required: ['weekStart', 'count'],
              additionalProperties: false
            }
          },
          avgCycleHours: { type: ['number', 'null'], description: 'Mean hours (1 decimal) from createdAt to updatedAt over done issues; null when none' },
          byActor: {
            type: 'array',
            description: 'Action counts per actor (desc, max 10)',
            items: {
              type: 'object',
              properties: { actor: { type: 'string' }, actions: { type: 'integer' } },
              required: ['actor', 'actions'],
              additionalProperties: false
            }
          },
          byStatus: {
            type: 'array',
            description: 'Current counts per status (canonical order, zeros included)',
            items: {
              type: 'object',
              properties: { status: { $ref: '#/components/schemas/Status' }, count: { type: 'integer' } },
              required: ['status', 'count'],
              additionalProperties: false
            }
          }
        },
        required: ['weeklyDone', 'avgCycleHours', 'byActor', 'byStatus'],
        additionalProperties: false
      },
      GitRefs: {
        type: 'object',
        description: 'GET /api/projects/{projectId}/git-refs shape',
        properties: {
          branches: { type: 'array', items: { type: 'string' } },
          worktrees: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string', description: 'Path basename' }, path: { type: 'string' } },
              required: ['name', 'path'],
              additionalProperties: false
            }
          }
        },
        required: ['branches', 'worktrees'],
        additionalProperties: false
      },
      GitCommit: {
        type: 'object',
        properties: {
          hash: { type: 'string', description: 'Abbreviated sha (%h)' },
          subject: { type: 'string' },
          when: { type: 'string', description: 'Relative date (%ar), e.g. "2 hours ago"' }
        },
        required: ['hash', 'subject', 'when'],
        additionalProperties: false
      },
      CommitList: {
        type: 'object',
        description: 'GET /api/projects/{projectId}/commits shape',
        properties: { commits: { type: 'array', items: { $ref: '#/components/schemas/GitCommit' } } },
        required: ['commits'],
        additionalProperties: false
      },
      Ok: {
        type: 'object',
        description: 'Action-only response',
        properties: { ok: { type: 'boolean', const: true } },
        required: ['ok'],
        additionalProperties: false
      },
      Meta: {
        type: 'object',
        description: 'GET /api/meta shape',
        properties: {
          statuses: { type: 'array', items: { $ref: '#/components/schemas/Status' } },
          priorities: { type: 'array', items: { $ref: '#/components/schemas/Priority' } }
        },
        required: ['statuses', 'priorities'],
        additionalProperties: false
      },
      NextIssue: {
        type: 'object',
        description: 'GET /api/projects/{projectId}/next shape',
        properties: {
          issue: { anyOf: [ISSUE_REF, { type: 'null' }] }
        },
        required: ['issue'],
        additionalProperties: false
      },
      StoreEvent: {
        type: 'object',
        description: 'SSE `change` payload',
        properties: {
          type: { type: 'string', description: 'project.created | project.deleted | issue.created | issue.updated | issue.deleted | comment.added | …' },
          payload: { type: 'object', additionalProperties: true },
          revision: { type: 'integer' },
          at: { type: 'string', format: 'date-time' }
        },
        required: ['type', 'payload', 'revision', 'at']
      },
      CreateDirectoryRequest: {
        type: 'object',
        description: 'POST /api/directories body (strict)',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', minLength: 1 },
          workspacePath: { type: 'string' },
          serverUrl: { type: 'string', maxLength: 500 }
        },
        required: ['name'],
        additionalProperties: false
      },
      PatchDirectoryRequest: {
        type: 'object',
        description: 'PATCH /api/directories/{directoryId} body (strict)',
        properties: {
          name: { type: 'string', minLength: 1 },
          workspacePath: { type: 'string' },
          serverUrl: { type: 'string', maxLength: 500 },
        },
        additionalProperties: false
      },
      PatchProjectRequest: {
        type: 'object',
        description: 'PATCH /api/projects/{projectId} body (strict); routing is inherited from Directory',
        properties: {
          name: { type: 'string', minLength: 1 },
          defaultSessionId: { type: ['string', 'null'] },
          labels: { type: 'string' },
          sessionId: { type: 'string', description: 'Compatibility alias for defaultSessionId; empty string clears it' }
        },
        additionalProperties: false
      },
      CreateProjectRequest: {
        type: 'object',
        description: 'POST /api/projects body (strict — unknown keys → 400)',
        properties: {
          id: { type: 'string', description: 'Omit for a generated 8-char id; an existing id → 409' },
          name: { type: 'string', minLength: 1 },
          directoryId: { type: 'string', description: 'Workspace directory to create the project under' },
          defaultSessionId: { type: ['string', 'null'], description: 'Selected OpenCode session for new tasks' },
          workspacePath: { type: 'string', description: 'Legacy compatibility input; used only when directoryId is omitted to initialize a Directory' },
          wakeChannel: { type: 'string', description: 'Legacy compatibility input; used only when directoryId is omitted to initialize a Directory' },
          labels: { type: 'string' }
        },
        required: ['name'],
        additionalProperties: false
      },
      UpdateProjectRequest: {
        type: 'object',
        description: 'PATCH /api/projects/{projectId} body — all fields optional (strict); routing is inherited from Directory',
        properties: {
          name: { type: 'string', minLength: 1 },
          defaultSessionId: { type: ['string', 'null'] },
          labels: { type: 'string', description: 'Comma-separated project labels' },
          sessionId: { type: 'string', description: 'Compatibility alias for defaultSessionId; empty string clears it' }
        },
        additionalProperties: false
      },
      CreateIssueRequest: {
        type: 'object',
        description: 'POST /api/projects/{projectId}/issues body — projectId lives in the path (strict)',
        properties: {
          parentId: { type: ['string', 'null'] },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          status: { $ref: '#/components/schemas/Status' },
          priority: { $ref: '#/components/schemas/Priority' },
          labels: { type: 'string' },
          branch: { type: 'string' },
          worktree: { type: ['string', 'null'], description: 'null = unbound' },
          sessionId: {
            type: ['string', 'null'],
            description: 'opencode session to bind at creation. Precedence: explicit sessionId → x-taskboard-session header → project default session → null (unbound).'
          },
          assignee: { type: 'string' },
          startDate: { type: ['string', 'null'], format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          dueDate: { type: ['string', 'null'], format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          confirm: { type: 'boolean', description: 'T7-36 escape hatch: with TASKBOARD_HUMAN_DONE=1, an agent may create an issue directly at done after the user confirmed in conversation' }
        },
        required: ['title'],
        additionalProperties: false
      },
      UpdateIssueRequest: {
        type: 'object',
        description: 'PATCH /api/issues/{id} body — all fields optional, version optional on REST (strict)',
        properties: {
          title: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          status: { $ref: '#/components/schemas/Status' },
          priority: { $ref: '#/components/schemas/Priority' },
          labels: { type: 'string' },
          branch: { type: 'string' },
          worktree: { type: ['string', 'null'], description: 'null clears (stored as "")' },
          sessionId: { type: ['string', 'null'], description: 'opencode session binding; null = unbind' },
          assignee: { type: 'string' },
          parentId: { type: ['string', 'null'] },
          startDate: { type: ['string', 'null'], format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          dueDate: { type: ['string', 'null'], format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          version: { type: 'integer', minimum: 1, description: 'Optimistic lock — mismatch → 409' },
          confirm: { type: 'boolean', description: 'T7-36 escape hatch: with TASKBOARD_HUMAN_DONE=1, an agent may set done after the user confirmed in conversation' }
        },
        additionalProperties: false
      },
      AddCommentRequest: {
        type: 'object',
        description: 'POST /api/issues/{id}/comments body (strict)',
        properties: {
          author: { type: 'string' },
          body: { type: 'string', minLength: 1 }
        },
        required: ['body'],
        additionalProperties: false
      },
      AddDependencyRequest: {
        type: 'object',
        description: 'POST /api/issues/{id}/dependencies body (strict)',
        properties: {
          dependsOnId: { type: 'string', minLength: 1, description: 'The issue blocking {id}' }
        },
        required: ['dependsOnId'],
        additionalProperties: false
      },
      ClaimRequest: {
        type: 'object',
        description:
          'POST /api/issues/{id}/claim|heartbeat|release body (strict). ttlMinutes: lease duration on claim ' +
          '(default 30, max 1440), a fresh duration on heartbeat, tolerated-and-ignored on release. ' +
          'sessionId (claim only): binds the claimer\'s opencode session when the issue is unbound; ' +
          'an existing binding is never overwritten (tolerated-and-ignored on heartbeat/release).',
        properties: {
          agent: { type: 'string', minLength: 1, description: 'Claim holder identity' },
          ttlMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
          sessionId: { type: 'string', minLength: 1, description: 'Claimer\'s opencode session (bind-only-if-unbound)' }
        },
        required: ['agent'],
        additionalProperties: false
      },
      BackupCreated: {
        type: 'object',
        description: 'POST /api/backup response — path of the freshly written snapshot',
        properties: {
          path: { type: 'string', description: 'Absolute path of the snapshot (taskboard-YYYYMMDD-HHMMSS.sqlite)' }
        },
        required: ['path'],
        additionalProperties: false
      },
      Attachment: {
        type: 'object',
        description: 'Attachment metadata row — the body lives on disk, never in this payload',
        properties: {
          id: { type: 'string', description: 'Generated 8-char id (used by the download route)' },
          issueId: { type: 'string' },
          filename: { type: 'string', description: 'Basenamed client filename' },
          size: { type: 'integer', minimum: 1, description: 'Body size in bytes' },
          actor: { type: 'string', description: 'Uploader (x-taskboard-actor header)' },
          createdAt: { type: 'string', format: 'date-time' }
        },
        required: ['id', 'issueId', 'filename', 'size', 'actor', 'createdAt'],
        additionalProperties: false
      }
    },
    responses: {
      BadRequest: errorResponse('Validation error (bad enum/filter value, malformed body, unknown strict-schema key, impossible parent/dependency)'),
      Unauthorized: errorResponse('A valid browser session cookie or configured TASKBOARD_TOKEN was not presented'),
      Forbidden: errorResponse('Read-only mode (TASKBOARD_READONLY=1) rejects mutating requests; reserved for done-requires-confirmation'),
      NotFound: errorResponse('Resource (project / issue / parent / dependency target) not found'),
      Conflict: errorResponse('Optimistic-lock version mismatch, duplicate project id, or duplicate dependency edge (reserved for claim conflicts)'),
      InternalError: errorResponse('Unexpected server error')
    },
    parameters: {
      ProjectId: {
        name: 'projectId',
        in: 'path',
        required: true,
        description: 'Project id',
        schema: { type: 'string' }
      },
      IssueId: {
        name: 'id',
        in: 'path',
        required: true,
        description: 'Issue id',
        schema: { type: 'string' }
      },
      DependsOnId: {
        name: 'dependsOnId',
        in: 'path',
        required: true,
        description: 'Issue id this one depends on',
        schema: { type: 'string' }
      },
      CommentId: {
        name: 'commentId',
        in: 'path',
        required: true,
        description: 'Comment id',
        schema: { type: 'string' }
      },
      Actor: {
        name: 'x-taskboard-actor',
        in: 'header',
        required: false,
        description: 'Acting agent/user name, recorded in the issue activity log',
        schema: { type: 'string' }
      },
      Session: {
        name: 'x-taskboard-session',
        in: 'header',
        required: false,
        description: 'Caller OpenCode session id used when creating an issue without an explicit body sessionId (overrides the project default, not the body)',
        schema: { type: 'string' }
      }
    },
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'taskboard_session',
        description: 'Server-managed browser session created by /api/auth/login or /api/auth/setup'
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Optional legacy TASKBOARD_TOKEN for CLI/MCP clients'
      },
      tokenQuery: {
        type: 'apiKey',
        in: 'query',
        name: 'token',
        description: 'TASKBOARD_TOKEN value as `?token=<token>` — the form the SSE stream uses (only enforced when TASKBOARD_TOKEN is set)'
      }
    }
  }
};

export default openApiSpec;
