import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '#src/lib/errors.ts';
import { type ApiErrorResponse, apiErrorResponseSchema } from '#src/lib/http.ts';
import { getRequestId } from '#src/plugins/request-context.ts';

/**
 * Turns every thrown error into the ApiErrorResponse shape.
 *  - AppError subclasses carry their own status code (see src/lib/errors.ts)
 *  - Fastify's own validation / not-found errors get friendlier bodies
 *  - anything else is logged and reported as a 500, so internals never leak
 */
async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError | Error, _req, res) => {
    const correlationId = getRequestId();

    if ('code' in error && error.code === 'FST_ERR_VALIDATION') {
      const validation = (error as FastifyError).validation ?? [];
      return res.status(400).send({
        statusCode: 400,
        message: 'Validation error',
        error: 'Bad Request',
        correlationId,
        subErrors: validation.map((e) => `${e.instancePath} ${e.message ?? ''}`.trim()).join(', '),
      } satisfies ApiErrorResponse);
    }

    if ('code' in error && error.code === 'FST_ERR_NOT_FOUND') {
      return res.status(404).send({
        statusCode: 404,
        message: 'Not Found',
        error: 'Not Found',
        correlationId,
      } satisfies ApiErrorResponse);
    }

    if (error instanceof AppError) {
      // 4xx are expected; only log the unexpected ones at error level.
      if (error.statusCode >= 500) {
        fastify.log.error({ err: error, cause: error.cause }, error.message);
      }
      return res.status(error.statusCode).send({
        statusCode: error.statusCode,
        message: error.message,
        error: error.error,
        correlationId,
      } satisfies ApiErrorResponse);
    }

    fastify.log.error(error);
    return res.status(500).send({
      statusCode: 500,
      message: 'Internal Server Error',
      error: 'Internal Server Error',
      correlationId,
    } satisfies ApiErrorResponse);
  });

  // Makes `$ref: 'ApiErrorResponse#'` available to route schemas.
  fastify.addSchema(apiErrorResponseSchema);
}

export default fp(errorHandlerPlugin, { name: 'errorHandler' });
