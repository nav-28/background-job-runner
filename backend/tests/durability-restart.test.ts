import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeDb, truncateAll } from '#tests/helpers.ts';

/**
 *
 * The engine suite (`tests/engine/durability.test.ts`) simulates a crash by calling
 * `stop({ drain: false })`, which leaves the database in exactly the state a `SIGKILL` does.
 * That proves the recovery code. It does not prove that the *deployed backend* recovers, because
 * there is no process in it to kill. So this test spawns `src/index.ts` as a child on an
 * ephemeral port, talks to it only over HTTP, kills it with SIGKILL mid-flight, starts a second
 * one, and asks the API what happened. The brief says this and the no-collision check are the two
 * it verifies most carefully.
 *
 * Nothing here sleeps for a fixed duration hoping something happened: readiness is polled on
 * `/health`, and every state assertion polls the API until it settles or the test fails loudly.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('durability across a real process restart', () => {
  const backendRoot = fileURLToPath(new URL('..', import.meta.url));

  /** Two jobs run at once, so five of them guarantee both a running and a queued population. */
  const CONCURRENCY = 2;
  const JOB_COUNT = 5;
  /** Long enough that a job cannot finish before the kill, short enough to finish the test. */
  const JOB_MS = 3000;

  interface Server {
    port: number;
    child: ChildProcess;
    /**
     * Resolves when the child is gone. Created at spawn time, not at kill time: attaching a
     * `once('exit')` listener to a process that has already exited waits forever, which is
     * exactly the hang a cleanup path must not have.
     */
    exited: Promise<void>;
    stderr: () => string;
  }

  const running: Server[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Binds :0, reads the port the OS chose, and hands it back. */
  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const probe = createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });

  const waitFor = async (label: string, check: () => Promise<boolean>, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) {
        return;
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for: ${label}`);
  };

  /**
   * Spawns the real entry point and waits for `/health`.
   *
   * Engine settings are passed as environment variables rather than baked in, which is the whole
   * point of reading them from env in the first place — this test is also the proof that the
   * plugin's env wiring works. `.env` is still loaded by the child, but dotenv does not override
   * variables already present, so these win.
   */
  const startServer = async (): Promise<Server> => {
    const port = await freePort();
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: backendRoot,
      env: {
        ...process.env,
        NODE_ENV: 'development', // anything but `test`: the claim loop must autostart
        HOST: '127.0.0.1',
        PORT: String(port),
        LOG_LEVEL: 'warn',
        ENGINE_CONCURRENCY: String(CONCURRENCY),
        ENGINE_POLL_INTERVAL_MS: '50',
        ENGINE_BOOT_SWEEP: 'true',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const server: Server = {
      port,
      child,
      exited: new Promise<void>((resolve) => child.once('exit', () => resolve())),
      stderr: () => stderr,
    };
    running.push(server);

    await waitFor(
      `the backend on :${port} to answer /health (stderr: ${stderr})`,
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`the backend exited with ${child.exitCode}. stderr:\n${stderr}`);
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          return res.status === 200;
        } catch {
          return false; // not listening yet
        }
      },
      30_000,
    );

    return server;
  };

  /**
   * SIGKILL: no shutdown hook runs, nothing drains, nothing is written. A power cut.
   * Safe to call on a process that is already gone — `kill()` on a reaped pid is a no-op and
   * `exited` has already resolved.
   */
  const kill = async (server: Server): Promise<void> => {
    server.child.kill('SIGKILL');
    await server.exited;
  };

  const api = async (server: Server, path: string, init: RequestInit = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1${path}`, init);
    return { status: res.status, body: await res.json() };
  };

  const authed = (token: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  interface Task {
    id: string;
    handle: string;
    status: string;
    attempts: number;
  }

  const listTasks = async (server: Server, token: string): Promise<Task[]> => {
    const { status, body } = await api(server, '/tasks?limit=100', authed(token));
    assert.equal(status, 200);
    return body as Task[];
  };

  const historyTypes = async (server: Server, token: string, handle: string): Promise<string[]> => {
    const { status, body } = await api(server, `/tasks/${handle}/history`, authed(token));
    assert.equal(status, 200);
    return (body as { type: string }[]).map((event) => event.type);
  };

  const countByStatus = (tasks: Task[], status: string) =>
    tasks.filter((task) => task.status === status).length;

  before(truncateAll);

  after(async () => {
    // Guaranteed even when the test above threw: an orphaned backend would claim the next
    // suite's rows and its boot sweep would requeue them.
    for (const server of running.splice(0)) {
      await kill(server);
    }
    await closeDb();
  });

  it('keeps every task and its status across a SIGKILL, requeues the orphans and finishes them', async () => {
    const first = await startServer();

    // The account is created through the API, so the test knows nothing the reviewer would not.
    const signup = await api(first, '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'durability@example.com',
        name: 'Durability',
        password: 'password123',
      }),
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const token = (signup.body as { token: string }).token;

    // ── Submit more work than the pool can run at once ──────────────────────
    const submitted: Task[] = [];
    for (let i = 0; i < JOB_COUNT; i++) {
      const res = await api(
        first,
        '/tasks',
        authed(token, {
          method: 'POST',
          body: JSON.stringify({ lane: 'scrape', params: { duration_ms: JOB_MS } }),
        }),
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      submitted.push(res.body as Task);
    }
    assert.equal(submitted.length, JOB_COUNT);

    // ── Wait until some are running and some are still queued ───────────────
    //
    // Two conditions, both of them load-bearing.
    //
    // The pool must be SATURATED, not merely busy. Waiting for `running >= 1` would sometimes
    // catch the instant after the first claim and before the second, which is a different
    // scenario from the one this test is about.
    //
    // And every in-flight job must already have recorded its `started` event. `claim` writes
    // `status = running` and `attempts + 1` in one atomic statement, and the `started` event is
    // the write immediately after it — a kill landing in that gap leaves an attempt that is
    // counted but has no `started` row, and the history below would then legitimately show one
    // fewer start than the task has attempts. That window is real and worth knowing about, but
    // it is a fact about a two-write sequence, not about restart recovery, and letting the test
    // land in it at random turns "one started event per execution" into a coin flip. Waiting for
    // it closes the window without weakening a single assertion.
    let beforeKill: Task[] = [];
    await waitFor('the pool saturated, with every in-flight job past its start', async () => {
      beforeKill = await listTasks(first, token);
      if (
        countByStatus(beforeKill, 'running') !== CONCURRENCY ||
        countByStatus(beforeKill, 'queued') < 1
      ) {
        return false;
      }
      for (const task of beforeKill.filter((t) => t.status === 'running')) {
        const types = await historyTypes(first, token, task.handle);
        if (!types.includes('started')) {
          return false;
        }
      }
      return true;
    });

    const wasRunning = beforeKill.filter((task) => task.status === 'running').map((t) => t.handle);
    assert.equal(wasRunning.length, CONCURRENCY);
    assert.equal(beforeKill.length, JOB_COUNT, 'nothing may be missing before the kill either');

    // ── Pull the plug ───────────────────────────────────────────────────────
    await kill(first);
    assert.notEqual(first.child.exitCode ?? first.child.signalCode, null, 'the process is gone');

    // ── A brand new process, with a brand new runner id ─────────────────────
    const second = await startServer();

    // Every task is still there, with a status that makes sense. The boot sweep runs inside
    // start(), which Fastify awaits in onReady BEFORE the socket is bound — so by the time
    // /health answered, no task can still be stranded in `running` from the dead runner.
    const afterRestart = await listTasks(second, token);
    assert.equal(afterRestart.length, JOB_COUNT, 'no task may be lost across the restart');
    assert.deepEqual(
      afterRestart.map((task) => task.id).sort(),
      submitted.map((task) => task.id).sort(),
      'the same tasks, not new ones',
    );
    for (const task of afterRestart) {
      assert.ok(
        ['queued', 'running', 'ready'].includes(task.status),
        `${task.handle} came back as ${task.status}`,
      );
    }

    // The orphaned work says out loud that it was recovered, rather than silently restarting.
    for (const handle of wasRunning) {
      const types = await historyTypes(second, token, handle);
      assert.ok(
        types.includes('requeued_on_restart'),
        `${handle} was running when the process died and must record its requeue: ${types}`,
      );
      assert.equal(types.filter((type) => type === 'accepted').length, 1, 'still one task');
    }

    // ── …and everything actually completes ──────────────────────────────────
    let finished: Task[] = [];
    await waitFor(
      'every task to finish',
      async () => {
        finished = await listTasks(second, token);
        return finished.every((task) => task.status === 'ready');
      },
      90_000,
    );

    assert.equal(finished.length, JOB_COUNT);
    let recovered = 0;
    for (const task of finished) {
      assert.equal(task.status, 'ready');

      // At-least-once, stated plainly: a task that was mid-flight when the process died runs its
      // handler again, and the attempt counter is honest about it rather than being reset by the
      // recovery. The expected count is derived from the task's OWN history rather than from the
      // poll before the kill — a job the pool claimed in the gap between that poll and the
      // SIGKILL is legitimately requeued too, and reading the history cannot disagree with
      // reality the way a snapshot taken a moment earlier can.
      const types = await historyTypes(second, token, task.handle);
      const requeues = types.filter((type) => type === 'requeued_on_restart').length;
      recovered += requeues > 0 ? 1 : 0;

      assert.equal(
        task.attempts,
        1 + requeues,
        `${task.handle}: ${task.attempts} attempts for ${requeues} requeue(s)`,
      );
      assert.equal(
        types.filter((type) => type === 'started').length,
        task.attempts,
        `${task.handle}: one started event per execution`,
      );
      assert.equal(types.filter((type) => type === 'ready').length, 1, 'exactly one completion');
      assert.equal(types.filter((type) => type === 'accepted').length, 1, 'still one task');
    }
    assert.ok(
      recovered >= wasRunning.length,
      `at least the ${wasRunning.length} in-flight jobs must have been recovered, got ${recovered}`,
    );

    // The result is genuinely retrievable after the restart — the state survived, not just a row.
    const collected = await api(second, `/tasks/${finished[0].handle}/result`, authed(token));
    assert.equal(collected.status, 200);
    assert.equal((collected.body as { collected: boolean }).collected, true);
  });
});
