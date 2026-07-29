import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '#src/lib/errors.ts';
import { type ApiErrorResponse, apiErrorResponseSchema } from '#src/lib/http.ts';
import { getRequestId, getUserId } from '#src/plugins/request-context.ts';

const reasonFor = (status: number): string => STATUS_CODES[status] ?? 'Error';

function isFastifyError(error: Error): error is FastifyError {
  const { code } = error as FastifyError;
  return typeof code === 'string' && code.startsWith('FST_');
}

function clientStatusOf(error: Error): number | null {
  const { statusCode } = error as FastifyError;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : null;
}

async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError | Error, _req, res) => {
    const correlationId = getRequestId();

    if (error instanceof AppError) {
      // 4xx are expected; only log the unexpected ones at error level.
      if (error.statusCode >= 500) {
        fastify.log.error({ err: error, cause: error.cause, userId: getUserId() }, error.message);
      }
      return res.status(error.statusCode).send({
        statusCode: error.statusCode,
        message: error.message,
        error: error.error,
        correlationId,
      } satisfies ApiErrorResponse);
    }

    // Validation is a 400 like the ones below, but only this branch has the per-field detail.
    if (isFastifyError(error) && error.code === 'FST_ERR_VALIDATION') {
      const validation = error.validation ?? [];
      return res.status(400).send({
        statusCode: 400,
        message: 'Validation error',
        error: 'Bad Request',
        correlationId,
        subErrors: validation.map((e) => `${e.instancePath} ${e.message ?? ''}`.trim()).join(', '),
      } satisfies ApiErrorResponse);
    }

    const clientStatus = clientStatusOf(error);
    if (clientStatus !== null) {
      fastify.log.debug({ err: error, userId: getUserId() }, 'client error');
      return res.status(clientStatus).send({
        statusCode: clientStatus,
        message: isFastifyError(error) ? error.message : reasonFor(clientStatus),
        error: reasonFor(clientStatus),
        correlationId,
      } satisfies ApiErrorResponse);
    }

    // No status, or a 5xx: genuinely unexpected.
    fastify.log.error({ err: error, userId: getUserId() });
    return res.status(500).send({
      statusCode: 500,
      message: 'Internal Server Error',
      error: 'Internal Server Error',
      correlationId,
    } satisfies ApiErrorResponse);
  });

  fastify.setNotFoundHandler((req, res) => {
    return res.status(404).send({
      statusCode: 404,
      message: `Route ${req.method}:${req.url} not found`,
      error: 'Not Found',
      correlationId: getRequestId(),
    } satisfies ApiErrorResponse);
  });

  fastify.addSchema(apiErrorResponseSchema);
}

export default fp(errorHandlerPlugin, { name: 'errorHandler' });
