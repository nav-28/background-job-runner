import { getDb } from '#src/db.ts';
import { DatabaseError } from '#src/lib/errors.ts';
import type { Paginated } from '#src/lib/http.ts';
import type { ApiKey, ApiKeyIdentity } from '#src/modules/apikey/apikey.types.ts';

/**
 * How stale `lastUsedAt` is allowed to get. The gate lives in the WHERE clause so
 * a busy key costs one UPDATE per minute rather than one per request.
 */
const LAST_USED_THROTTLE = '60 seconds';

export async function insert(apiKey: ApiKey): Promise<void> {
  const db = getDb();
  try {
    await db`
      INSERT INTO api_keys ${db(apiKey, 'id', 'userId', 'name', 'keyHash', 'prefix', 'createdAt')}
    `;
  } catch (error: unknown) {
    throw new DatabaseError(
      'Failed to insert api key',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** Active (non-revoked) keys for one user, newest first. */
export async function findAllByUserPaginated(
  userId: string,
  { limit, offset, page }: { limit: number; offset: number; page: number },
): Promise<Paginated<ApiKey>> {
  const db = getDb();

  // ORDER BY is required for stable pagination.
  const [rows, [count]] = await Promise.all([
    db<ApiKey[]>`
      SELECT * FROM api_keys
      WHERE "userId" = ${userId} AND "revokedAt" IS NULL
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM api_keys
      WHERE "userId" = ${userId} AND "revokedAt" IS NULL
    `,
  ]);

  return { data: [...rows], count: Number(count?.count ?? 0), limit, page };
}

/** Looks a key up by hash. Revoked keys are invisible here, so they fail auth. */
export async function findActiveByHash(keyHash: string): Promise<ApiKeyIdentity | null> {
  const db = getDb();
  const [row] = await db<{ id: string; userId: string }[]>`
    SELECT id, "userId" FROM api_keys
    WHERE "keyHash" = ${keyHash} AND "revokedAt" IS NULL
  `;

  return row ? { keyId: row.id, userId: row.userId } : null;
}

/**
 * Records that a key was used, at most once per throttle window. The condition is
 * in SQL rather than in the service so it stays a single round trip and stays
 * correct across processes.
 */
export async function touchLastUsed(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE api_keys
    SET "lastUsedAt" = now()
    WHERE id = ${id}
      AND ("lastUsedAt" IS NULL OR "lastUsedAt" < now() - ${LAST_USED_THROTTLE}::interval)
  `;
}

/**
 * Revokes a key in place — the row is kept so an audit of what a leaked key did
 * remains possible. Scoped by user so one account cannot revoke another's key.
 */
export async function revokeById(userId: string, id: string): Promise<boolean> {
  const db = getDb();
  const result = await db`
    UPDATE api_keys
    SET "revokedAt" = now()
    WHERE id = ${id} AND "userId" = ${userId} AND "revokedAt" IS NULL
  `;

  return result.count > 0;
}
