# syntax=docker/dockerfile:1

# ---- Base ----
# Node 24 Alpine for small image size; native TS execution (no build step needed)
FROM node:24-alpine AS base

RUN corepack enable
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps

# Manifests only, with their workspace paths intact, so this layer caches on dependency changes
# rather than on every source edit.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY backend/package.json ./backend/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @app/backend

# ---- Production ----
FROM base AS production

# dumb-init for proper PID 1 signal forwarding
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
# Bind to all interfaces so the container is reachable from the Docker network
ENV HOST=0.0.0.0

RUN addgroup -g 1001 -S nodejs && \
    adduser  -S fastify -u 1001 -G nodejs

# pnpm keeps one content-addressed store at the workspace root and symlinks into it from each
# package, so both directories are needed — backend/node_modules alone is a tree of dead links.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules

# package.json carries "type":"module" and the "#src/*" subpath imports
COPY backend/package.json ./backend/
COPY backend/src ./backend/src

USER fastify
WORKDIR /app/backend

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw r;process.exit(0)}).catch(()=>process.exit(1))"]

CMD ["dumb-init", "node", "./src/index.ts"]
