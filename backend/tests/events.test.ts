import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { getDb } from '#src/db.ts';
import { buildTestApp, closeDb, truncateAll, validUser } from '#tests/helpers.ts';

/**
 * The SSE stream, over a real socket.
 *
 * `app.inject()` cannot be used here: it buffers the whole response and resolves when the handler
 * returns, and an event stream never returns. So this suite binds an ephemeral port and drives it
 * with `fetch`, reading the response body incrementally exactly as a browser would.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('event stream', async () => {
  const app = await buildTestApp({
    engine: { config: { concurrency: 2, pollIntervalMs: 25, maxAttempts: 1 } },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  interface Frame {
    id?: string;
    event?: string;
    data: Record<string, unknown>;
  }

  /** One line-oriented SSE frame. Comments (`: heartbeat`) and a bare `retry:` carry no data. */
  const parseFrame = (raw: string): Frame | null => {
    // Only these three are collected; `retry:` and anything else is ignored, and a leading
    // colon (a comment, which is what the heartbeat is) never matches a field name.
    const fields: Record<string, string[]> = { id: [], event: [], data: [] };

    for (const line of raw.split('\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        fields[line.slice(0, colon)]?.push(line.slice(colon + 1).replace(/^ /, ''));
      }
    }

    return fields.data.length === 0
      ? null
      : { id: fields.id[0], event: fields.event[0], data: JSON.parse(fields.data.join('\n')) };
  };

  interface Stream {
    frames: Frame[];
    header: (name: string) => string | null;
    close: () => void;
    waitFor: (label: string, predicate: () => boolean, timeoutMs?: number) => Promise<void>;
  }

  interface ConnectOptions {
    /** Sent as the `Last-Event-ID` request header, the way a browser reconnects. */
    lastEventId?: number;
    /** Sent as `?since=`, the way a curl client reconnects. */
    since?: number;
  }

  const open: Stream[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Connects and collects frames in the background. Every stream is closed in `after`. */
  const connect = async (credential: string, options: ConnectOptions = {}): Promise<Stream> => {
    const controller = new AbortController();
    const url =
      options.since === undefined
        ? `${base}/api/v1/events`
        : `${base}/api/v1/events?since=${options.since}`;
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${credential}`,
        ...(options.lastEventId === undefined
          ? {}
          : { 'last-event-id': String(options.lastEventId) }),
      },
      signal: controller.signal,
    });
    assert.equal(res.status, 200, 'the stream must open');
    assert.ok(res.body, 'the stream must have a body');

    const frames: Frame[] = [];
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (frame) {
            frames.push(frame);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      // Aborting the fetch rejects the iteration; that is the ordinary disconnect path.
    })().catch(() => undefined);

    const stream: Stream = {
      frames,
      header: (name) => res.headers.get(name),
      close: () => controller.abort(),
      waitFor: async (label, predicate, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) {
            return;
          }
          await sleep(20);
        }
        throw new Error(
          `timed out waiting for: ${label}. Frames so far: ${frames
            .map((frame) => `${frame.event}#${frame.id}`)
            .join(', ')}`,
        );
      },
    };
    open.push(stream);
    return stream;
  };

  const signup = async (email = validUser.email) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      body: { ...validUser, email },
    });
    assert.equal(res.statusCode, 201, 'signup fixture must succeed');
    const { token, user } = res.json();
    return { token: token as string, userId: user.id as string };
  };

  const submit = async (token: string, lane: string, params: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
      body: { lane, params },
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json();
  };

  const getTask = async (token: string, handle: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${handle}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.json();
  };

  const waitForStatus = async (token: string, handle: string, status: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await getTask(token, handle)).status === status) {
        return;
      }
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${handle} to be ${status}`);
  };

  /** Every stored event id for a user — the ground truth a replay is measured against. */
  const storedEventIds = async (userId: string): Promise<number[]> => {
    const rows = await getDb()<{ id: string }[]>`
      SELECT id FROM task_events WHERE "userId" = ${userId} ORDER BY id ASC`;
    return rows.map((row) => Number(row.id));
  };

  const ids = (frames: Frame[]) => frames.map((frame) => Number(frame.id));

  before(truncateAll);

  beforeEach(async () => {
    for (const stream of open.splice(0)) {
      stream.close();
    }
    await app.engine.stop();
    await truncateAll();
    await app.engine.start();
  });

  after(async () => {
    for (const stream of open.splice(0)) {
      stream.close();
    }
    await app.close();
    await closeDb();
  });

  describe('framing', () => {
    it('sets the streaming headers and frames every event with an id', async () => {
      const { token } = await signup();
      const stream = await connect(token);

      assert.match(stream.header('content-type') ?? '', /^text\/event-stream/);
      assert.match(stream.header('cache-control') ?? '', /no-cache/);
      assert.equal(stream.header('x-accel-buffering'), 'no');

      const task = await submit(token, 'scrape', { duration_ms: 100 });
      await stream.waitFor('a ready event', () =>
        stream.frames.some((frame) => frame.event === 'ready'),
      );

      for (const frame of stream.frames) {
        assert.ok(frame.id, 'every frame carries an id, or reconnection cannot work');
        assert.equal(
          Number(frame.id),
          frame.data.id,
          'the SSE id must be the event id a client replays from',
        );
        assert.equal(frame.event, frame.data.type, 'the event name must match the payload type');
        assert.equal(frame.data.handle, task.handle);
      }
    });

    it('carries the four contract event shapes, with user_id stripped', async () => {
      const { token } = await signup();
      const stream = await connect(token);

      const ok = await submit(token, 'scrape', { duration_ms: 60 });
      const doomed = await submit(token, 'report', { fail: true, duration_ms: 60 });
      const victim = await submit(token, 'scrape', { duration_ms: 30_000 });
      await waitForStatus(token, victim.handle, 'running');
      await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${victim.handle}/cancel`,
        headers: { authorization: `Bearer ${token}` },
      });

      await stream.waitFor(
        'accepted, ready, failed and cancelled',
        () =>
          ['accepted', 'ready', 'failed', 'cancelled'].every((type) =>
            stream.frames.some((frame) => frame.event === type),
          ),
        20_000,
      );

      const dataFor = (type: string, handle: string) => {
        const frame = stream.frames.find((f) => f.event === type && f.data.handle === handle);
        assert.ok(frame, `no ${type} frame arrived for ${handle}`);
        return frame.data;
      };

      // The brief fixes `type`, `handle`, `lane` plus the per-type extras. `id` and `task_id` are
      // additive — `id` is what makes cursor replay work. `user_id` must NOT be here: it is bus
      // routing metadata, and the client already knows who it is.
      const accepted = dataFor('accepted', ok.handle);
      assert.deepEqual(Object.keys(accepted).sort(), [
        'handle',
        'id',
        'lane',
        'summary',
        'task_id',
        'type',
      ]);
      assert.equal(accepted.type, 'accepted');
      assert.equal(accepted.lane, 'scrape');
      assert.equal(typeof accepted.summary, 'string');

      const ready = dataFor('ready', ok.handle);
      assert.deepEqual(Object.keys(ready).sort(), [
        'handle',
        'id',
        'lane',
        'summary',
        'task_id',
        'type',
      ]);

      const failed = dataFor('failed', doomed.handle);
      assert.deepEqual(Object.keys(failed).sort(), [
        'handle',
        'id',
        'lane',
        'reason',
        'retryable',
        'task_id',
        'type',
      ]);
      assert.equal(failed.retryable, true);
      assert.match(String(failed.reason), /simulated failure/);

      const cancelled = dataFor('cancelled', victim.handle);
      assert.deepEqual(Object.keys(cancelled).sort(), ['handle', 'id', 'lane', 'task_id', 'type']);

      for (const frame of stream.frames) {
        assert.equal(frame.data.user_id, undefined, 'user_id must never reach a client');
      }
    });

    it('also streams the informational types a dashboard uses', async () => {
      const { token } = await signup();
      const stream = await connect(token);
      await submit(token, 'scrape', { duration_ms: 60 });

      await stream.waitFor('a started event', () =>
        stream.frames.some((frame) => frame.event === 'started'),
      );
      const started = stream.frames.find((frame) => frame.event === 'started');
      assert.ok(started?.data.detail, 'informational events carry their raw detail');
    });
  });

  describe('scoping', () => {
    it('never delivers another user’s events', async () => {
      const owner = await signup('owner@example.com');
      const stranger = await signup('stranger@example.com');

      const strangerStream = await connect(stranger.token);
      const ownerStream = await connect(owner.token);

      const task = await submit(owner.token, 'scrape', { duration_ms: 60 });
      await ownerStream.waitFor('the owner’s ready event', () =>
        ownerStream.frames.some((frame) => frame.event === 'ready'),
      );
      // Give anything mis-routed a generous chance to show up.
      await sleep(200);

      assert.deepEqual(strangerStream.frames, [], 'a stream is scoped to its own user');
      assert.ok(ownerStream.frames.every((frame) => frame.data.handle === task.handle));
    });
  });

  describe('reconnection', () => {
    it('replays exactly what was missed from Last-Event-ID — no gaps, no duplicates', async () => {
      const { token, userId } = await signup();

      const first = await connect(token);
      const early = await submit(token, 'scrape', { duration_ms: 60 });
      await first.waitFor('the first task to finish', () =>
        first.frames.some((frame) => frame.event === 'ready'),
      );
      const cursor = Math.max(...ids(first.frames));
      first.close();
      // Let the server observe the disconnect before anything else happens.
      await sleep(100);

      // Work happens while nobody is listening.
      const missedA = await submit(token, 'report', { duration_ms: 60 });
      const missedB = await submit(token, 'report', { fail: true, duration_ms: 60 });
      await waitForStatus(token, missedA.handle, 'ready');
      await waitForStatus(token, missedB.handle, 'failed');

      const expected = (await storedEventIds(userId)).filter((id) => id > cursor);
      assert.ok(expected.length >= 5, 'the fixture must actually miss several events');

      const second = await connect(token, { lastEventId: cursor });
      await second.waitFor(
        'the replay to catch up',
        () => ids(second.frames).length >= expected.length,
      );
      await sleep(150); // …and then prove nothing extra arrives.

      const replayed = ids(second.frames);
      assert.deepEqual(replayed, expected, 'the replay is exactly the missed events, in order');
      assert.equal(new Set(replayed).size, replayed.length, 'no duplicates');
      assert.ok(
        !second.frames.some((frame) => frame.data.handle === early.handle),
        'nothing already delivered may be replayed',
      );

      // And the reconnected stream is live, not just a replay.
      const later = await submit(token, 'scrape', { duration_ms: 60 });
      await second.waitFor('a live event after the replay', () =>
        second.frames.some((frame) => frame.data.handle === later.handle),
      );
      const all = ids(second.frames);
      assert.equal(new Set(all).size, all.length, 'live delivery must not duplicate the replay');
    });

    it('replays from ?since= too, so a curl client can catch up', async () => {
      const { token, userId } = await signup();

      const task = await submit(token, 'scrape', { duration_ms: 60 });
      await waitForStatus(token, task.handle, 'ready');
      const stored = await storedEventIds(userId);
      const cursor = stored[0]; // everything after `accepted`

      const stream = await connect(token, { since: cursor });
      await stream.waitFor('the replay', () => ids(stream.frames).length >= stored.length - 1);
      assert.deepEqual(
        ids(stream.frames),
        stored.filter((id) => id > cursor),
      );
    });

    it('sends the whole history when no cursor is supplied', async () => {
      const { token, userId } = await signup();
      const task = await submit(token, 'scrape', { duration_ms: 60 });
      await waitForStatus(token, task.handle, 'ready');
      const stored = await storedEventIds(userId);

      const stream = await connect(token);
      await stream.waitFor('the full replay', () => ids(stream.frames).length >= stored.length);
      assert.deepEqual(ids(stream.frames), stored);
    });

    /**
     * The race the subscribe-then-replay ordering exists for: an event that fires in the window
     * between the cursor query and the live subscription. Submitting without awaiting the connect
     * puts work into exactly that window.
     */
    it('loses nothing and duplicates nothing when events fire during the handover', async () => {
      const { token, userId } = await signup();

      const connecting = connect(token);
      const submits = Promise.all([
        submit(token, 'scrape', { duration_ms: 40 }),
        submit(token, 'report', { duration_ms: 40 }),
        submit(token, 'scrape', { duration_ms: 40 }),
      ]);
      const stream = await connecting;
      const tasks = await submits;

      for (const task of tasks) {
        await waitForStatus(token, task.handle, 'ready');
      }
      const stored = await storedEventIds(userId);

      await stream.waitFor(
        'every event to arrive',
        () => new Set(ids(stream.frames)).size >= stored.length,
      );
      await sleep(150);

      const received = ids(stream.frames);
      assert.equal(new Set(received).size, received.length, `duplicate frames: ${received}`);
      assert.deepEqual(
        [...received].sort((a, b) => a - b),
        stored,
        'every stored event must have been delivered exactly once',
      );
    });
  });

  describe('authentication', () => {
    it('rejects a stream with no credential', async () => {
      const res = await fetch(`${base}/api/v1/events`);
      assert.equal(res.status, 401);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      await res.body?.cancel();
    });
  });

  describe('content negotiation', () => {
    it('tells a client that refuses text/event-stream that there is nothing else here', async () => {
      const { token } = await signup();
      const res = await fetch(`${base}/api/v1/events`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      assert.equal(res.status, 406, 'this route has no non-SSE representation');
      await res.body?.cancel();
    });

    it('streams to a client that sends no Accept header at all, which is what curl does', async () => {
      const { token } = await signup();
      const controller = new AbortController();
      const res = await fetch(`${base}/api/v1/events`, {
        headers: { authorization: `Bearer ${token}`, accept: '*/*' },
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      controller.abort();
    });
  });
});
