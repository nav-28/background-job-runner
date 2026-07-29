import Swagger from '@fastify/swagger';
import SwaggerUI from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Serves the OpenAPI document built from the route schemas.
 * The frontend generates its typed API client from /api-docs/json — see
 * frontend/orval.config.ts — so route schemas are the single source of truth.
 * Must be registered before any route.
 */
async function swaggerPlugin(fastify: FastifyInstance) {
  await fastify.register(Swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'web-app-template API',
        description: 'REST API for web-app-template.',
        version: process.env.npm_package_version ?? '0.0.0',
      },
    },
    // A fix for schemas whos names are not generated correctly
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' ? json.$id : `def-${i}`,
    },
  });

  await fastify.register(SwaggerUI, { routePrefix: '/api-docs' });
}

export default fp(swaggerPlugin, { name: 'swagger' });
