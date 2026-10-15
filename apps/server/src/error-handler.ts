// Global error handler: domain errors -> proper status codes.
// Extracted as-is from the former monolithic server.ts (P1 semantics).
import { FastifyInstance } from 'fastify';
import { ConflictError, NotFoundError, ValidationError } from '@taskboard/core';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<Error>((err, _req, reply) => {
    let status: number;
    if (err instanceof NotFoundError) status = 404;
    else if (err instanceof ConflictError) status = 409;
    else if (err instanceof ValidationError) status = 400;
    else {
      const sc = (err as { statusCode?: number }).statusCode;
      status = typeof sc === 'number' && sc >= 400 ? sc : 500;
    }
    if (status >= 500) {
      console.error('[taskboard]', err);
      return reply.code(status).send({ error: 'Internal Server Error' });
    }
    return reply.code(status).send({ error: err.message });
  });
}
