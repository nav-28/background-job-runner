// biome-ignore-all lint/suspicious/noConsole: a CLI script, not application code

/**
 * Clears seeded data so `pnpm db:seed` can apply it again.
 *
 * Seeds are tracked in `schema_migrations` alongside real migrations, so once applied they never
 * re-apply — and `pnpm test:integration` truncates `users`, which deletes the seeded rows while
 * leaving those version records behind. `db:seed` then silently does nothing.
 *
 * The obvious fix, `db:seed:down` twice, does not work either: the `down` sections delete by fixed
 * uuid, but the integration suite leaves users carrying the *same emails* under different uuids, so
 * re-applying trips `users_email_key` (the seeds declare `ON CONFLICT (id)`, which does not cover
 * it) and the whole run aborts.
 *
 * So: truncate, forget the version records, and let dbmate apply the seeds fresh.
 *
 * DESTRUCTIVE — drops every task, event, key and user in the target database. It is a dev fixture
 * reset, not a migration.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DBMATE_DATABASE_URL;
if (!url) {
  console.error('DBMATE_DATABASE_URL is not set. Run via `pnpm db:seed:reset`.');
  process.exit(1);
}

const seedsDir = fileURLToPath(new URL('../db/seeds/', import.meta.url));
const versions = readdirSync(seedsDir)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.split('_')[0]);

if (versions.length === 0) {
  console.error(`No seed files found in ${seedsDir}`);
  process.exit(1);
}

// TRUNCATE on tables with no rows emits a notice; nothing here needs to hear about it.
const sql = postgres(url, { max: 1, onnotice: () => undefined });

try {
  await sql`TRUNCATE TABLE task_events, tasks, api_keys, users`;
  const forgotten = await sql`
    DELETE FROM schema_migrations WHERE version IN ${sql(versions)} RETURNING version
  `;
  console.log(
    `Truncated seeded tables; forgot ${forgotten.length}/${versions.length} seed version(s). ` +
      'Applying seeds…',
  );
} finally {
  await sql.end();
}
