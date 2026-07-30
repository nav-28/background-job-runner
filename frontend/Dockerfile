# syntax=docker/dockerfile:1

# ---- Base ----
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- Dependencies ----
# Install all deps (incl. dev) for the build step, cached on the lockfile.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY frontend/package.json ./frontend/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @app/frontend

# ---- Builder ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY frontend ./frontend
# Base URL the browser uses to reach the API. NEXT_PUBLIC_* values are inlined
# into the client bundle by `next build`, so this must be known at BUILD time —
# setting it only at runtime is too late and the bundle keeps the baked-in value.
# It must be an origin the *browser* can resolve, not a Docker network hostname.
# Override with: --build-arg NEXT_PUBLIC_API_URL=...
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/frontend
RUN pnpm build

# ---- Runner ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs


COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/frontend/.next/static ./frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/frontend/public ./frontend/public

USER nextjs
EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

CMD ["node", "frontend/server.js"]
