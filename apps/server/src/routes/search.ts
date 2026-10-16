// /api/search route (T6-30): full-text search over issue titles,
// descriptions and comment bodies. The Store owns the FTS/LIKE strategy —
// this is a thin pass-through with query validation.
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Store, ValidationError } from '@taskboard/core';

interface SearchQuery { q?: string }

const searchRoutes: FastifyPluginAsync<{ store: Store }> = async (app, { store }) => {
  app.get('/api/search', async (req: FastifyRequest<{ Querystring: SearchQuery }>, reply) => {
    const q = req.query.q;
    if (typeof q !== 'string' || q.trim().length < 1) {
      throw new ValidationError('query parameter q is required (min 1 char)');
    }
    return store.search(q);
  });
};

export default searchRoutes;
