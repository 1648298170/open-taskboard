// GET /api/openapi.json — serves the OpenAPI 3.1 document. The spec object
// lives in src/openapi-spec.ts (single source); apps/server/openapi.json is
// its serialized copy, written by scripts/write-openapi.mjs.
import { FastifyPluginAsync } from 'fastify';
import { openApiSpec } from '../openapi-spec.js';

const openapiRoutes: FastifyPluginAsync = async app => {
  app.get('/api/openapi.json', async () => openApiSpec);
};

export default openapiRoutes;
