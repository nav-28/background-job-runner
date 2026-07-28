// biome-ignore-all lint/suspicious/noConsole: manual smoke script, not application code
/**
 * Manual end-to-end walk through the engine, with no HTTP layer present.
 *
 *   cd backend && node --env-file=.env scripts/engine-smoke.ts
 *
 * Doubles as a rehearsal for the recorded demo: every scenario below maps to one of the
 * assessment's success criteria. Wipes this user's tasks on start.
 */
import { closeDb, getDb } from '#src/db.ts';
import { createEngine } from '#src/engine/index.ts';
import type { EngineLogFn, EngineLogger } from '#src/engine/types.ts';
import { mockWorkers } from '#src/workers/mock-worker.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rule = (title: string) =>
  console.log(`\n\x1b[1m── ${title} ${'─'.repeat(58 - title.length)}\x1b[0m`);
const say = (msg: string) => console.log(`   ${msg}`);

/**
 * A console stand-in for the pino logger the Fastify plugin will inject.
 *
 * Its only job is to make the engine's background failures visible in a manual run — the run
 * should print nothing from here at all, and anything that does appear is worth reading.
 */
const at =
  (level: string): EngineLogFn =>
  (first: unknown, ...rest: unknown[]) => {
    const [msg, fields] =
      typeof first === 'object' && first !== null
        ? [String(rest[0] ?? ''), first]
        : [String(first), {}];
    console.log(`   \x1b[33m▲ ${level.toUpperCase()} ${msg}\x1b[0m ${JSON.stringify(fields)}`);
  };
const logger: EngineLogger = {
  debug: () => undefined, // the engine says nothing at debug; keep the transcript readable
  info: at('info'),
  warn: at('warn'),
  error: at('error'),
};

/** Polls until `check` passes, so the script never races the runner. */
async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  const db = getDb();
  await db`INSERT INTO users (id, email, name)
           VALUES (${USER}, 'dev@example.com', 'Dev User')
           ON CONFLICT (id) DO NOTHING`;
  await db`DELETE FROM tasks WHERE "userId" = ${USER}`;

  // The engine knows no lanes; the caller registers the workers it wants.
  const engine = createEngine({
    workers: mockWorkers,
    concurrency: 2,
    pollIntervalMs: 100,
    maxAttempts: 3,
    logger,
  });
  engine.subscribe(USER, (e) => console.log(`   \x1b[2m⚡ ${JSON.stringify(e)}\x1b[0m`));
  await engine.start();

  say(
    `runner ${engine.config.runnerId}  concurrency=${engine.config.concurrency}  ` +
      `jobTimeout=${engine.config.jobTimeoutMs}ms`,
  );
  say(
    `lanes: ${engine
      .lanes()
      .map((l) => l.lane)
      .join(', ')}`,
  );

  // ── 1. Instant handle: submit must return long before the work finishes.
  rule('1. instant handle');
  const t0 = Date.now();
  const slow = await engine.submit(USER, 'scrape', { duration_ms: 10_000 });
  say(`submit returned in ${Date.now() - t0}ms → ${slow.handle} (${slow.status}) for a 10s job`);

  // ── 2. Numbering is per lane, not global.
  rule('2. per-lane numbering');
  const report1 = await engine.submit(USER, 'report', { duration_ms: 400 });
  const scrape2 = await engine.submit(USER, 'scrape', { duration_ms: 400 });
  say(`report → ${report1.handle}   second scrape → ${scrape2.handle}`);

  // ── 3. Concurrency cap: only 2 may be running at once.
  rule('3. concurrency cap (limit 2)');
  await engine.submit(USER, 'scrape', { duration_ms: 400 });
  await engine.submit(USER, 'report', { duration_ms: 400 });
  for (let i = 0; i < 6; i++) {
    const s = await engine.stats(USER);
    say(
      `running=${s.running} queued=${s.queued} ready=${s.ready}  ${s.running <= 2 ? 'ok' : 'VIOLATION'}`,
    );
    await sleep(300);
  }

  // ── 4. Cancel a running job — the worker must actually stop.
  rule('4. cancel a running job');
  say(`${slow.handle} is ${(await engine.get(USER, slow.handle)).status}; cancelling mid-run`);
  const cancelled = await engine.cancel(USER, slow.handle);
  say(`${cancelled.handle} → ${cancelled.status} (no ready event should follow)`);

  // ── 5. Cancelling freed scrape-1, so the next scrape reuses that number.
  rule('5. handle recycling');
  const recycled = await engine.submit(USER, 'scrape', { duration_ms: 300 });
  say(`next scrape got ${recycled.handle} ${recycled.handle === 'scrape-1' ? '(recycled)' : ''}`);

  // ── 6. Retry with backoff, then a permanent failure.
  rule('6. failure and retry');
  const doomed = await engine.submit(USER, 'report', { fail: true, duration_ms: 50 });
  await waitFor(
    'doomed to fail',
    async () => (await engine.get(USER, doomed.handle)).status === 'failed',
  );
  const failed = await engine.get(USER, doomed.handle);
  say(`${failed.handle} → ${failed.status} after ${failed.attempts} attempts`);
  say(`error: ${JSON.stringify(failed.error)}`);

  const retried = await engine.retry(USER, failed.handle);
  say(`operator retry → ${retried.status}, budget now ${retried.maxAttempts}`);

  // ── 7. Collect a finished result.
  rule('7. collect a result');
  await waitFor(
    'a ready task',
    async () => (await engine.list(USER, { status: 'ready' })).length > 0,
  );
  const [ready] = await engine.list(USER, { status: 'ready' });
  const collected = await engine.collect(USER, ready.handle);
  say(`collected ${collected.handle}: ${JSON.stringify(collected.result)}`);
  say(`collected flag = ${collected.collected}`);

  // ── 8. State history for one task.
  rule('8. state history');
  for (const ev of await engine.history(USER, collected.handle)) {
    say(`${ev.at.toISOString()}  ${ev.type}`);
  }

  rule('final state');
  say(JSON.stringify(await engine.stats(USER)));
  for (const t of await engine.list(USER, {})) {
    say(
      `${t.handle.padEnd(12)} ${t.status.padEnd(10)} attempts=${t.attempts} collected=${t.collected}`,
    );
  }

  await engine.stop();
  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});
