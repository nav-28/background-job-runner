import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  apiKeyIdParamsSchema,
  apiKeyPaginatedResponseSchema,
  createApiKeyBodySchema,
  createdApiKeyResponseSchema,
  listApiKeysQuerySchema,
  toApiKeyResponse,
} from '#src/modules/apikey/apikey.schema.ts';
import * as apiKeyService from '#src/modules/apikey/apikey.service.ts';
import { requireAuth } from '#src/plugins/auth.ts';

/**
 * HTTP layer for API keys. Registered in src/app.ts under /api/v1.
 *
 * Every route here is session-only. Key management is deliberately outside what a
 * key can do: a leaked key cannot mint more keys, cannot revoke the ones that would
 * lock it out, and cannot enumerate its owner's other credentials.
 */
const SESSION_ONLY = { auth: { session: true, apiKey: false } } as const;

const apiKeyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/keys',
    {
      config: SESSION_ONLY,
      schema: {
        operationId: 'listApiKeys',
        description: 'List your active API keys. Never returns the secret.',
        tags: ['keys'],
        querystring: listApiKeysQuerySchema,
        response: {
          200: apiKeyPaginatedResponseSchema,
          401: { $ref: 'ApiErrorResponse#' },
          403: { $ref: 'ApiErrorResponse#' },
        },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const result = await apiKeyService.listApiKeys(userId, req.query);
      return res.status(200).send({ ...result, data: result.data.map(toApiKeyResponse) });
    },
  );

  app.post(
    '/keys',
    {
      config: SESSION_ONLY,
      schema: {
        operationId: 'createApiKey',
        description: 'Create an API key. The secret is returned once and never again.',
        tags: ['keys'],
        body: createApiKeyBodySchema,
        response: {
          201: createdApiKeyResponseSchema,
          401: { $ref: 'ApiErrorResponse#' },
          403: { $ref: 'ApiErrorResponse#' },
        },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const { apiKey, plaintext } = await apiKeyService.createApiKey(userId, req.body.name);
      return res.status(201).send({ ...toApiKeyResponse(apiKey), key: plaintext });
    },
  );

  app.delete(
    '/keys/:id',
    {
      config: SESSION_ONLY,
      schema: {
        operationId: 'revokeApiKey',
        description: 'Revoke an API key. The row is kept so its history stays auditable.',
        tags: ['keys'],
        params: apiKeyIdParamsSchema,
        response: {
          204: { type: 'null', description: 'API Key Revoked' },
          401: { $ref: 'ApiErrorResponse#' },
          403: { $ref: 'ApiErrorResponse#' },
          404: { $ref: 'ApiErrorResponse#' },
        },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      await apiKeyService.revokeApiKey(userId, req.params.id);
      return res.status(204).send(null);
    },
  );
};

export default apiKeyRoutes;
