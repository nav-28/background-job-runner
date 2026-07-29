import { type Static, Type } from 'typebox';
import { paginatedResponseSchema, paginationQuerySchema } from '#src/lib/http.ts';
import type { ApiKey } from '#src/modules/apikey/apikey.types.ts';

/** TypeBox schemas for the API key routes. The stored hash appears in none of them. */

/** POST /api/v1/keys body */
export const createApiKeyBodySchema = Type.Object(
  {
    name: Type.String({
      example: 'ci-pipeline',
      description: 'Label so a human can tell their keys apart',
      minLength: 1,
      maxLength: 100,
    }),
  },
  { title: 'CreateApiKeyRequest' },
);
export type CreateApiKeyBody = Static<typeof createApiKeyBodySchema>;

/** GET /api/v1/keys querystring */
export const listApiKeysQuerySchema = Type.Object({ ...paginationQuerySchema });
export type ListApiKeysQuery = Static<typeof listApiKeysQuerySchema>;

/** DELETE /api/v1/keys/:id params */
export const apiKeyIdParamsSchema = Type.Object({
  id: Type.String({
    format: 'uuid',
    example: '2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
    description: "Entity's id",
  }),
});

const apiKeyProperties = {
  id: Type.String({
    format: 'uuid',
    example: '2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
    description: "Entity's id",
  }),
  name: Type.String({ example: 'ci-pipeline', description: 'Label for this key' }),
  prefix: Type.String({
    example: 'jrk_A1b2C3d4',
    description: 'The leading characters of the key, so it can be identified in a list',
  }),
  lastUsedAt: Type.Union([Type.String(), Type.Null()], {
    example: '2020-11-24T17:43:15.970Z',
    description: 'When the key last authenticated a request; null if never used',
  }),
  createdAt: Type.String({
    example: '2020-11-24T17:43:15.970Z',
    description: 'Entity creation date',
  }),
};

/** An API key on the wire. Never carries the secret or its hash. */
export const apiKeyResponseSchema = Type.Object(apiKeyProperties, { title: 'ApiKeyResponse' });
export type ApiKeyResponse = Static<typeof apiKeyResponseSchema>;

/**
 * The creation response, and the only place `key` ever appears. It is not stored in
 * plaintext, so a caller who loses it has to create a new key.
 */
export const createdApiKeyResponseSchema = Type.Object(
  {
    ...apiKeyProperties,
    key: Type.String({
      example: 'jrk_<32-random-bytes-base64url>',
      description: 'The secret. Shown exactly once — it cannot be retrieved again.',
    }),
  },
  { title: 'CreatedApiKeyResponse' },
);

export const apiKeyPaginatedResponseSchema = paginatedResponseSchema(
  apiKeyResponseSchema,
  'ApiKeyPaginatedResponse',
);

/** Domain key -> wire shape. Fields are listed explicitly so `keyHash` cannot leak. */
export function toApiKeyResponse(apiKey: ApiKey): ApiKeyResponse {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    lastUsedAt: apiKey.lastUsedAt ? apiKey.lastUsedAt.toISOString() : null,
    createdAt: apiKey.createdAt.toISOString(),
  };
}
