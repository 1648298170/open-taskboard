// Typed domain errors: callers (server/MCP/CLI) map these to proper status codes.
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  /** Stable machine-readable business code (e.g. COMMENT_DISPATCH_PROTECTED). */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}
