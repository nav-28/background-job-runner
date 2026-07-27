import { randomUUID } from 'node:crypto';
import Cors from '@fastify/cors';
import Helmet from '@fastify/helmet';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { Type } from 'typebox';
import env from '#src/config/env.ts';
import userRoutes from '#src/modules/user/user.routes.ts';
import errorHandler from '#src/plugins/error-handler.ts';
import requestContext from '#src/plugins/request-context.ts';
import swagger from '#src/plugins/swagger.ts';

/**
 * Builds a fully configured Fastify instance without listening.
 * Used by src/index.ts to serve, and by tests via app.inject().
 *
 * To add a module: create src/modules/<name>/<name>.routes.ts and register it
 * at the bottom of this function. That's the whole wiring story — reading this
 * file tells you every route the app serves.
 */
export async function buildApp(overrides: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: env.log.level,
      redact: ['headers.authorization'],
    },
    genReqId: (req) => {
      // header best practice: don't use "x-" https://www.rfc-editor.org/info/rfc6648
      return (req.headers['request-id'] as string) ?? randomUUID();
    },
    routerOptions: {
      ignoreDuplicateSlashes: true,
    },
    ajv: {
      // TypeBox emits `example` into schemas; Ajv's strict mode rejects unknown keywords.
      customOptions: { keywords: ['example'] },
    },
    ...overrides,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Sensible default security headers. CSP is relaxed in development so the
  // Swagger UI (inline scripts/styles) can render.
  await app.register(Helmet, {
    global: true,
    contentSecurityPolicy: !env.isDevelopment,
    crossOriginEmbedderPolicy: !env.isDevelopment,
  });

  // Origins come from CORS_ORIGIN (comma-separated). Unset means: allow the local
  // Next.js frontend in development, and disable CORS in production (there the
  // frontend calls the API same-origin through its Next.js proxy).
  await app.register(Cors, {
    origin: env.server.corsOrigin
      ? env.server.corsOrigin.split(',').map((origin) => origin.trim())
      : env.isDevelopment
        ? ['http://localhost:3001']
        : false,
    credentials: true,
  });

  await app.register(requestContext);
  await app.register(errorHandler);
  await app.register(swagger);

  // Liveness probe — also used by the Dockerfile HEALTHCHECK.
  app.get(
    '/health',
    {
      logLevel: 'silent',
      schema: {
        operationId: 'health',
        description: 'Health check',
        tags: ['health'],
        response: {
          200: Type.Object(
            { status: Type.String({ example: 'ok' }) },
            { title: 'HealthResponse', description: 'Health Check Succeeded' },
          ),
        },
      },
    },
    async () => ({ status: 'ok' }),
  );

  // Modules
  await app.register(userRoutes, { prefix: '/api/v1' });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
