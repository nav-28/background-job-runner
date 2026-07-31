import postgres from 'postgres';
import env, { LogLevel } from '#src/config/env.ts';

let sql: ReturnType<typeof postgres> | null = null;

/** Returns the singleton DB connection, creating it lazily on first call. */
export function getDb(): ReturnType<typeof postgres> {
  if (!sql) {
    sql = postgres(env.db.url, {
      debug: (conn: number, query: string, params: unknown[]) => {
        if (env.log.level === LogLevel.debug) {
          console.debug(`SQL [conn ${conn}]: ${query.trim()} -- ${JSON.stringify(params)}`);
        }
      },
    });
  }
  return sql;
}

export async function closeDb() {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
}

/**
 * Builds a `WHERE a AND b AND c` fragment from a list of optional conditions.
 * Falsy entries are skipped, so callers can write `filters.email && db`email = ${...}``.
 * Returns an empty fragment when nothing is filtered.
 */
export function joinConditions(
  xs: (postgres.PendingQuery<postgres.Row[]> | false | undefined | null | '')[],
  joiner?: postgres.PendingQuery<postgres.Row[]>,
) {
  const db = getDb();
  const join = joiner ?? db`AND`;
  const filtered = xs.filter(Boolean) as postgres.PendingQuery<postgres.Row[]>[];

  if (filtered.length === 0) {
    return db``;
  }

  return filtered.reduce(
    (acc, fragment, i) => (i === 0 ? db`WHERE ${fragment}` : db`${acc} ${join} ${fragment}`),
    db``,
  );
}

/**
 * Runs a callback inside a transaction. Queries issued on `tx` share it.
 * Commits when the callback resolves, rolls back when it throws.
 */
export async function withTransaction<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.begin((tx) => fn(tx)) as Promise<T>;
}
