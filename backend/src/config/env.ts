import envSchema from 'env-schema';
import { type Static, Type } from 'typebox';

const NodeEnv = {
  development: 'development',
  production: 'production',
  test: 'test',
} as const;

export const LogLevel = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

const schema = Type.Object({
  POSTGRES_URL: Type.String(),
  POSTGRES_PASSWORD: Type.String(),
  POSTGRES_USER: Type.String(),
  POSTGRES_DB: Type.String(),
  LOG_LEVEL: Type.Enum(LogLevel),
  NODE_ENV: Type.Enum(NodeEnv),
  HOST: Type.String({ default: 'localhost' }),
  PORT: Type.Number({ default: 3000 }),
  // Comma-separated list of allowed CORS origins (e.g. "http://localhost:3001,https://app.example.com").
  // Leave empty to fall back to the sensible default (dev: allow the local frontend; prod: disabled).
  CORS_ORIGIN: Type.Optional(Type.String()),
  // Signs session JWTs. Deliberately has NO default: a shipped default signing key
  // is forgeable by anyone who has read the repo, so the app must refuse to boot
  // rather than come up quietly insecure.
  JWT_SECRET: Type.String({ minLength: 32 }),
  // Session lifetime, in seconds. Also the cookie's Max-Age.
  SESSION_TTL_SECONDS: Type.Number({ default: 14_400, minimum: 60 }),

  // ── The orchestration engine ────────────────────────────────────────────────
  /** Maximum jobs in flight in this process at once. */
  ENGINE_CONCURRENCY: Type.Number({ default: 4, minimum: 1 }),
  /** How often the claim loop runs when idle. A freed slot also triggers an immediate tick. */
  ENGINE_POLL_INTERVAL_MS: Type.Number({ default: 200, minimum: 10 }),
  /** How long a claimed row stays owned before another runner may steal it. */
  ENGINE_LEASE_MS: Type.Number({ default: 30_000, minimum: 1000 }),
  /** How often in-flight leases are bumped. Must be comfortably below ENGINE_LEASE_MS. */
  ENGINE_HEARTBEAT_MS: Type.Number({ default: 10_000, minimum: 100 }),
  /** Attempts a freshly submitted task gets before it is declared failed. */
  ENGINE_MAX_ATTEMPTS: Type.Number({ default: 3, minimum: 1 }),
  /** First retry delay; doubles per attempt. */
  ENGINE_BACKOFF_BASE_MS: Type.Number({ default: 500, minimum: 0 }),
  /** Ceiling on the exponential backoff, before jitter. */
  ENGINE_BACKOFF_MAX_MS: Type.Number({ default: 30_000, minimum: 0 }),
  /** Liveness backstop, not a per-job SLA. */
  ENGINE_JOB_TIMEOUT_MS: Type.Number({ default: 300_000, minimum: 1000 }),
  /** Requeue every `running` row this process does not own, once, at start(). */
  ENGINE_BOOT_SWEEP: Type.Boolean({ default: true }),
});

const env = envSchema<Static<typeof schema>>({
  dotenv: true,
  schema,
});

export default {
  nodeEnv: env.NODE_ENV,
  isDevelopment: env.NODE_ENV === NodeEnv.development,
  isProduction: env.NODE_ENV === NodeEnv.production,
  isTest: env.NODE_ENV === NodeEnv.test,
  version: process.env.npm_package_version ?? '0.0.0',
  log: {
    level: env.LOG_LEVEL,
  },
  server: {
    host: env.HOST,
    port: env.PORT,
    corsOrigin: env.CORS_ORIGIN,
  },
  db: {
    url: `postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.POSTGRES_URL}/${env.POSTGRES_DB}?sslmode=disable`,
  },
  auth: {
    jwtSecret: env.JWT_SECRET,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  },
  /** Every EngineConfig knob except `workers`, `bus`, `logger` and `runnerId`. */
  engine: {
    concurrency: env.ENGINE_CONCURRENCY,
    pollIntervalMs: env.ENGINE_POLL_INTERVAL_MS,
    leaseMs: env.ENGINE_LEASE_MS,
    heartbeatMs: env.ENGINE_HEARTBEAT_MS,
    maxAttempts: env.ENGINE_MAX_ATTEMPTS,
    backoffBaseMs: env.ENGINE_BACKOFF_BASE_MS,
    backoffMaxMs: env.ENGINE_BACKOFF_MAX_MS,
    jobTimeoutMs: env.ENGINE_JOB_TIMEOUT_MS,
    bootSweep: env.ENGINE_BOOT_SWEEP,
  },
};
