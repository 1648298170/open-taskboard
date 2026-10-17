# open-taskboard — no native deps (node:sqlite built into Node 22), so the
# image is plain node + pnpm. Build context: repo root.
#
#   docker compose build && docker compose up -d   # board on host port 47825
#
# NODE_IMAGE exists so compose can pin a registry mirror on networks where
# docker.io is unreliable; the default keeps the Dockerfile upstream-clean.
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS builder
# CN networks: corepack (fetches pnpm itself) and pnpm (fetches deps) both hit
# the npm registry — route both through npmmirror. The cache mount keeps
# downloaded tarballs alive across rebuild attempts.
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --ignore-scripts
# --ignore-scripts: the root postinstall (`pnpm -r build`) would run before the
# sources are COPYed in. Sources land next, then we build explicitly.
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    TASKBOARD_HOST=0.0.0.0 \
    TASKBOARD_DATA_DIR=/data
WORKDIR /app
COPY --from=builder /app /app
# 127.0.0.1 inside a container is unreachable from the host even with a port
# mapping — the bind address must stay 0.0.0.0 (ENV above pins it).
VOLUME /data
EXPOSE 47824
CMD ["node", "apps/server/dist/server.js"]
