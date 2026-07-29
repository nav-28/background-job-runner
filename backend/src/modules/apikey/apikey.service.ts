import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NotFoundError } from '#src/lib/errors.ts';
import { type Paginated, paginationParams } from '#src/lib/http.ts';
import * as apiKeyRepository from '#src/modules/apikey/apikey.repository.ts';
import type { ApiKey, ApiKeyIdentity, CreatedApiKey } from '#src/modules/apikey/apikey.types.ts';

/**
 * Business logic for machine credentials.
 *
 * A key is `jrk_` + 32 random bytes in base64url. Only its SHA-256 and a short
 * display prefix are stored, so a database dump does not yield usable credentials
 * and the plaintext is unrecoverable after creation.
 *
 * SHA-256 rather than a password KDF is deliberate: the secret is 256 bits of CSPRNG
 * output, so there is no guessable input to slow an attacker down over — and auth
 * runs on every machine request, where a memory-hard KDF would be the bottleneck.
 */

/**
 * The literal prefix every key carries. Two jobs: it lets the auth resolver decide
 * "key or JWT" without sniffing token structure, and it gives secret scanners a
 * stable pattern to grep for in commits and logs.
 */
export const API_KEY_PREFIX = 'jrk_';

const KEY_BYTES = 32;
/** How much of the key is stored in the clear so a human can tell two keys apart. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

function generateKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
}

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function createApiKey(userId: string, name: string): Promise<CreatedApiKey> {
  const plaintext = generateKey();
  const apiKey: ApiKey = {
    id: randomUUID(),
    userId,
    name,
    keyHash: hashKey(plaintext),
    prefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
  };

  await apiKeyRepository.insert(apiKey);
  return { apiKey, plaintext };
}

export async function listApiKeys(
  userId: string,
  query: { limit?: number; page?: number },
): Promise<Paginated<ApiKey>> {
  const { limit, page, offset } = paginationParams(query);
  return apiKeyRepository.findAllByUserPaginated(userId, { limit, page, offset });
}

export async function revokeApiKey(userId: string, id: string): Promise<void> {
  const revoked = await apiKeyRepository.revokeById(userId, id);
  if (!revoked) {
    // Same answer whether the key belongs to someone else or never existed, so
    // this endpoint cannot be used to probe for other users' key ids.
    throw new NotFoundError(`API key with id ${id} not found`);
  }
}

/**
 * Resolves a plaintext key to an identity, or null if it is malformed, unknown or
 * revoked. Callers get no detail about which — every failure is the same 401.
 */
export async function verifyApiKey(plaintext: string): Promise<ApiKeyIdentity | null> {
  if (!plaintext.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const identity = await apiKeyRepository.findActiveByHash(hashKey(plaintext));
  if (!identity) {
    return null;
  }

  await apiKeyRepository.touchLastUsed(identity.keyId);
  return identity;
}
