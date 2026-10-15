// Static hosting of the built web board — fastify-static when the build
// exists, otherwise a plain HTML hint page.
import fastifyStatic from '@fastify/static';
import { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// monorepo layout: apps/server/dist -> ../../ -> repo root -> apps/web/dist/web
export const WEB_DIST = join(__dirname, '..', '..', '..', 'apps', 'web', 'dist', 'web');

export interface StaticOptions {
  webDist: string;
}

export async function registerStatic(app: FastifyInstance, opts: StaticOptions): Promise<void> {
  if (existsSync(join(opts.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: opts.webDist, prefix: '/' });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      return '<meta charset="utf-8"><body style="font-family:monospace;background:#101312;color:#d6e2dc;padding:40px">' +
        '看板未构建 — 先运行 <code>pnpm build</code>，或开发模式 <code>pnpm dev</code>（vite 在 :5174）</body>';
    });
  }
}
