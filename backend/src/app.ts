import { randomUUID } from 'node:crypto';
import Cookie from '@fastify/cookie';
import Cors from '@fastify/cors';
import Helmet from '@fastify/helmet';
import { fastifySSE } from '@fastify/sse';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { Type } from 'typebox';
import env from '#src/config/env.ts';
import apiKeyRoutes from '#src/modules/apikey/apikey.routes.ts';
import authRoutes from '#src/modules/auth/auth.routes.ts';
import taskRoutes from '#src/modules/task/task.routes.ts';
import auth from '#src/plugins/auth.ts';
import engine, { type EnginePluginOptions } from '#src/plugins/engine.ts';
import errorHandler from '#src/plugins/error-handler.ts';
import requestContext from '#src/plugins/request-context.ts';
import swagger from '#src/plugins/swagger.ts';

export interface AppOptions {
  engine?: EnginePluginOptions;
}

export async function buildApp(overrides: FastifyServerOptions = {}, options: AppOptions = {}) {
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
  await app.register(fastifySSE, { heartbeatInterval: 15_000 });
  await app.register(Cookie);
  await app.register(auth);
  await app.register(engine, options.engine ?? {});

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
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(apiKeyRoutes, { prefix: '/api/v1' });
  await app.register(taskRoutes, { prefix: '/api/v1' });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
