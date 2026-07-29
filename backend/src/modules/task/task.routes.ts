import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { EngineEvent } from '#src/engine/types.ts';
import {
  createTaskBodySchema,
  eventsQuerySchema,
  lanesResponseSchema,
  listTasksQuerySchema,
  parseIsoDate,
  taskHandleParamsSchema,
  taskHistoryResponseSchema,
  taskIdParamsSchema,
  taskListResponseSchema,
  taskResponseSchema,
  taskStatsResponseSchema,
  toLaneResponse,
  toTaskEventResponse,
  toTaskResponse,
} from '#src/modules/task/task.schema.ts';
import { requireAuth } from '#src/plugins/auth.ts';

const AUTHENTICATED = { auth: true } as const;

const ERROR_RESPONSES = {
  400: { $ref: 'ApiErrorResponse#' },
  401: { $ref: 'ApiErrorResponse#' },
  404: { $ref: 'ApiErrorResponse#' },
  409: { $ref: 'ApiErrorResponse#' },
} as const;

/**
 * Where a reconnecting client wants the stream to resume.
 *
 * `Last-Event-ID` first: a browser's `EventSource` sends it automatically from the last `id:` it
 * saw, so reconnection needs no client code at all. `?since=` is the same cursor for a client
 * that has no `EventSource` — `curl -N '…/events?since=41'`. 0 means "everything you still have".
 */
function readCursor(lastEventId: string | null, since: number | undefined): number {
  const fromHeader = Number(lastEventId);
  if (lastEventId !== null && Number.isInteger(fromHeader) && fromHeader >= 0) {
    return fromHeader;
  }
  return since ?? 0;
}

const taskRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/tasks',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'createTask',
        description:
          'Enqueue a job. Returns the task — with its handle — before any worker runs; the ' +
          'submit path never waits on the work itself.',
        tags: ['tasks'],
        body: createTaskBodySchema,
        response: { 201: taskResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const task = await app.engine.submit(userId, req.body.lane, req.body.params);
      return res.status(201).send(toTaskResponse(task));
    },
  );

  app.get(
    '/tasks',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'listTasks',
        description:
          'Your tasks, newest first. Filter by status, lane and creation date; sort and page. ' +
          'Returns a bare array rather than the paginated envelope the rest of this API uses — ' +
          'the shape is fixed by the API contract.',
        tags: ['tasks'],
        querystring: listTasksQuerySchema,
        response: { 200: taskListResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const { status, lane, from, to, sort, limit, offset } = req.query;
      const tasks = await app.engine.list(userId, {
        status,
        lane,
        createdAfter: parseIsoDate(from, 'from'),
        createdBefore: parseIsoDate(to, 'to'),
        sort,
        limit,
        offset,
      });
      return res.status(200).send(tasks.map(toTaskResponse));
    },
  );

  app.get(
    '/tasks/stats',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'taskStats',
        description: 'Your task counts per status. Every status is present, zeroed when empty.',
        tags: ['tasks'],
        response: { 200: taskStatsResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      return res.status(200).send(await app.engine.stats(userId));
    },
  );

  app.get(
    '/tasks/id/:id',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'getTaskById',
        description:
          'One task by its immutable id. Handles are recycled, so this is the only address ' +
          'that keeps pointing at the same task once it retires.',
        tags: ['tasks'],
        params: taskIdParamsSchema,
        response: { 200: taskResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const task = await app.engine.getById(userId, req.params.id);
      return res.status(200).send(toTaskResponse(task));
    },
  );

  app.get(
    '/tasks/:handle',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'getTask',
        description: 'One task by handle. Resolves to the active task holding that number.',
        tags: ['tasks'],
        params: taskHandleParamsSchema,
        response: { 200: taskResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const task = await app.engine.get(userId, req.params.handle);
      return res.status(200).send(toTaskResponse(task));
    },
  );

  app.get(
    '/tasks/:handle/result',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'collectTaskResult',
        description:
          'Take delivery of a finished task: returns the whole task with `result` populated and ' +
          '`collected: true`, and releases its handle number for reuse. Only a ready, ' +
          'not-yet-collected task can be collected — anything else is a 409.',
        tags: ['tasks'],
        params: taskHandleParamsSchema,
        response: { 200: taskResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const task = await app.engine.collect(userId, req.params.handle);
      return res.status(200).send(toTaskResponse(task));
    },
  );

  app.get(
    '/tasks/:handle/history',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'getTaskHistory',
        description:
          'Every transition this task went through, oldest first, with timestamps. This is ' +
          'where a retry’s interim failure reason and a restart’s requeue are recorded.',
        tags: ['tasks'],
        params: taskHandleParamsSchema,
        response: { 200: taskHistoryResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const events = await app.engine.history(userId, req.params.handle);
      return res.status(200).send(events.map(toTaskEventResponse));
    },
  );

  app.post(
    '/tasks/:handle/cancel',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'cancelTask',
        description:
          'Cancel a queued or running task — a running worker is actually aborted, not left to ' +
          'finish quietly. Also dismisses a failed task, which is what releases its handle ' +
          'number. Any other state is a 409.',
        tags: ['tasks'],
        params: taskHandleParamsSchema,
        response: { 200: taskResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const task = await app.engine.cancel(userId, req.params.handle);
      return res.status(200).send(toTaskResponse(task));
    },
  );

  app.post(
    '/tasks/:handle/retry',
    {
      config: AUTHENTICATED,
      schema: {
        operationId: 'retryTask',
        description:
          'Requeue a failed task with a fresh attempt budget. `attempts` is a lifetime counter ' +
          'and is deliberately not reset. Only a failed task can be retried.',
        tags: ['tasks'],
        params: taskHandleParamsSchema,
        response: { 200: taskResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      const task = await app.engine.retry(userId, req.params.handle);
      return res.status(200).send(toTaskResponse(task));
    },
  );

  app.get(
    '/lanes',
    {
      schema: {
        operationId: 'listLanes',
        description:
          'What this engine can run, and the parameters each lane takes. Enough to render a ' +
          'submission form without hard-coding anything about a lane.',
        tags: ['tasks'],
        response: { 200: lanesResponseSchema },
      },
    },
    async (_req, res) => {
      return res.status(200).send(app.engine.lanes().map(toLaneResponse));
    },
  );

  /**
   * The obvious sequence — replay from the cursor, then subscribe — drops every event that fires
   * in the window between the two, and that window is a database round trip wide. So:
   *
   *   1. subscribe FIRST, buffering into an array instead of writing
   *   2. replay `eventsSince(cursor)` and write those
   *   3. flush the buffer, skipping anything the replay already delivered
   *   4. go live
   *
   * Steps 3 and 4 contain no `await`, so no event can slip in between draining the buffer and
   * going live; that is why the id set can be dropped afterwards rather than growing forever.
   */
  app.get(
    '/events',
    {
      config: AUTHENTICATED,
      sse: 'only',
      schema: {
        operationId: 'streamEvents',
        description:
          'Server-sent stream of lifecycle events for your tasks. Every frame carries an `id`, ' +
          'so a browser reconnects with `Last-Event-ID` — or curl with `?since=` — and receives ' +
          'exactly what it missed. `accepted`, `ready`, `failed` and `cancelled` are the ' +
          'contract; other types are informational and may be ignored.',
        tags: ['tasks'],
        querystring: eventsQuerySchema,
        // No `response`: the payload is a stream of frames, not a document.
      },
    },
    async (req, res) => {
      const { userId } = requireAuth(req);
      res.sse.keepAlive();

      const cursor = readCursor(res.sse.lastEventId, req.query.since);
      const delivered = new Set<number>();
      const buffered: EngineEvent[] = [];
      let live = false;

      const emit = (event: EngineEvent): void => {
        if (!res.sse.isConnected) {
          return;
        }

        const { user_id: _userId, ...wire } = event;

        void res.sse
          .send({ id: String(event.id), event: event.type, data: wire })
          .catch((error: unknown) => {
            req.log.debug({ err: error, eventId: event.id }, 'sse: dropped a frame');
          });
      };

      const unsubscribe = app.engine.subscribe(userId, (event) => {
        if (live) {
          emit(event);
          return;
        }
        buffered.push(event);
      });
      res.sse.onClose(unsubscribe);

      const replayed = await app.engine.eventsSince(userId, cursor);
      if (!res.sse.isConnected) {
        unsubscribe();
        return;
      }

      res.sse.sendHeaders();
      // sendHeaders only writes it so we need to flush it so actually send it
      res.raw.flushHeaders();

      for (const event of replayed) {
        delivered.add(event.id);
        emit(event);
      }
      for (const event of buffered.splice(0)) {
        if (!delivered.has(event.id)) {
          emit(event);
        }
      }
      live = true;
      delivered.clear();
    },
  );
};

export default taskRoutes;
