// Writes apps/server/openapi.json from the compiled single source
// (dist/openapi-spec.js). Run via `pnpm --filter @taskboard/server openapi`
// after a build whenever src/openapi-spec.ts changes.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openApiSpec } from '../dist/openapi-spec.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'openapi.json');
await writeFile(out, JSON.stringify(openApiSpec, null, 2) + '\n', 'utf8');
console.log(`wrote ${out}`);
