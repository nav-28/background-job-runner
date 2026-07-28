import { getDb, joinConditions } from '#src/db.ts';
import { ConflictError, DatabaseError } from '#src/lib/errors.ts';
import type { Paginated } from '#src/lib/http.ts';
import type { User, UserFilters } from '#src/modules/user/user.types.ts';

const UNIQUE_VIOLATION = '23505'; // https://www.postgresql.org/docs/current/errcodes-appendix.html

/**
 * SQL for the users table. Nothing here knows about HTTP.
 *
 * postgres.js tagged templates parameterize values automatically:
 *   db`SELECT * FROM users WHERE id = ${id}`   -> $1 bind, not string concat
 */

export async function insert(user: User): Promise<void> {
  const db = getDb();
  try {
    await db`
      INSERT INTO users ${db(user, 'id', 'createdAt', 'updatedAt', 'email', 'name')}
    `;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === UNIQUE_VIOLATION) {
      throw new ConflictError('User with this email already exists', error);
    }
    throw new DatabaseError(
      'Failed to insert user',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export async function findAllPaginated(
  { limit, offset, page }: { limit: number; offset: number; page: number },
  filters: UserFilters = {},
): Promise<Paginated<User>> {
  const db = getDb();
  const where = joinConditions([filters.email && db`email = ${filters.email}`]);

  // ORDER BY is required for stable pagination — without it Postgres may return
  // rows in a different order per page and items can repeat or be skipped.
  const [rows, [{ count }]] = await Promise.all([
    db<User[]>`
      SELECT * FROM users ${where}
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    db<{ count: string }[]>`SELECT COUNT(*) as count FROM users ${where}`,
  ]);

  return { data: [...rows], count: Number(count), limit, page };
}

export async function deleteById(id: string): Promise<boolean> {
  const db = getDb();
  const result = await db`DELETE FROM users WHERE id = ${id}`;
  return result.count > 0;
}
