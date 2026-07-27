# syntax=docker/dockerfile:1

# ---- Base ----
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- Dependencies ----
# Install all deps (incl. dev) for the build step, cached on the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts || \
    pnpm install --ignore-scripts

# ---- Builder ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next.js evaluates rewrites() during `next build` and bakes the result into
# .next/routes-manifest.json, so the backend origin must be known at BUILD time —
# setting BACKEND_URL only at runtime is too late and the proxy would fall back
# to localhost:3000. Override with: --build-arg BACKEND_URL=...
ARG BACKEND_URL=http://backend:3000
ENV BACKEND_URL=${BACKEND_URL}
# Client-side API base URL: empty string => same-origin, handled by the Next rewrite proxy.
ENV NEXT_PUBLIC_API_URL=""
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- Runner ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Backend origin the Next.js proxy forwards /api/* to (override in compose).
ENV BACKEND_URL=http://backend:3000

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

# Next.js "standalone" output ships a self-contained server + only the needed deps.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
