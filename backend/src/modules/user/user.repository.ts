import { getDb } from '#src/db.ts';
import { ConflictError, DatabaseError } from '#src/lib/errors.ts';
import type { User } from '#src/modules/user/user.types.ts';

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
      INSERT INTO users ${db(user, 'id', 'createdAt', 'updatedAt', 'email', 'name', 'passwordHash')}
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

export async function findById(id: string): Promise<User | null> {
  const db = getDb();
  const [user] = await db<User[]>`SELECT * FROM users WHERE id = ${id}`;
  return user ?? null;
}

/** Email is normalised to lowercase by the service, so this is an exact match. */
export async function findByEmail(email: string): Promise<User | null> {
  const db = getDb();
  const [user] = await db<User[]>`SELECT * FROM users WHERE email = ${email}`;
  return user ?? null;
}
