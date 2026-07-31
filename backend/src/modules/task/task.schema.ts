import { type Static, Type } from 'typebox';
import type { Task, TaskEventWithTask } from '#src/engine/types.ts';
import type { LaneInfo } from '#src/engine/workers/types.ts';
import { BadRequestError } from '#src/lib/errors.ts';

const ISO_EXAMPLE = '2026-05-30T18:00:00.000Z';

export const taskStatusSchema = Type.Union(
  [
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('ready'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ],
  { title: 'TaskStatus', description: 'Where a task is in its lifecycle' },
);

/**
 * An open object: every key the caller sent survives serialisation.
 *
 * `Type.Unsafe` rather than `Type.Object({}, …)` for the TypeScript side only — the emitted JSON
 * Schema is identical, but `Static<>` becomes `Record<string, unknown>` instead of `{}`, which is
 * what the engine's `submit(userId, lane, params)` takes.
 */
function openObject(description: string) {
  return Type.Unsafe<Record<string, unknown>>({
    type: 'object',
    additionalProperties: true,
    description,
  });
}

export const taskErrorSchema = Type.Object(
  {
    reason: Type.String({
      example: 'simulated failure',
      description: 'Why it failed, in the worker’s own words — never a generic "failed"',
    }),
    retryable: Type.Boolean({
      example: true,
      description:
        'Whether the error is transient by nature. Stays true on a transient error that ran ' +
        'out of attempts, because "we stopped trying" is not "this can never work".',
    }),
  },
  { title: 'TaskError', additionalProperties: true },
);

const taskProperties = {
  id: Type.String({
    format: 'uuid',
    example: '2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
    description:
      'Stable identity. Handles are recycled, so `scrape-1` may name three different tasks ' +
      'over an afternoon; this never changes and addresses retired tasks too.',
  }),
  handle: Type.String({
    example: 'scrape-1',
    description: 'Short human-friendly name, `<lane>-<n>`, numbered per lane and recycled',
  }),
  lane: Type.String({ example: 'scrape', description: 'Which worker runs this task' }),
  params: openObject('Whatever the submitter sent, normalised against the lane’s descriptors'),
  status: taskStatusSchema,
  result: Type.Unknown({
    description: 'The worker’s output. Populated only while `status` is `ready`, else null.',
  }),
  error: Type.Union([taskErrorSchema, Type.Null()], {
    description: 'Populated only while `status` is `failed`, else null.',
  }),
  attempts: Type.Integer({
    example: 1,
    description:
      'Lifetime execution count — one per claim, never reset. A manual retry extends the ' +
      'budget instead, so this stays honest about how much work a task has cost.',
  }),
  collected: Type.Boolean({
    example: false,
    description: 'Flips to true once the result is retrieved, which releases the handle number',
  }),
  is_seed: Type.Boolean({
    example: false,
    description:
      'Fixture data for the dashboard. Seed rows are excluded from the claim query and from ' +
      'both recovery sweeps, so a seeded `running` task never executes.',
  }),
  created_at: Type.String({ example: ISO_EXAMPLE, description: 'When the task was accepted' }),
  updated_at: Type.String({ example: ISO_EXAMPLE, description: 'Last state change' }),
};

export const taskResponseSchema = Type.Object(taskProperties, { title: 'TaskResponse' });
export type TaskResponse = Static<typeof taskResponseSchema>;

export const taskListResponseSchema = Type.Array(taskResponseSchema, { title: 'TaskListResponse' });

/** POST /api/v1/tasks body */
export const createTaskBodySchema = Type.Object(
  {
    lane: Type.String({
      example: 'scrape',
      description: 'A lane from GET /lanes. An unknown one is a 400.',
      minLength: 1,
    }),
    params: Type.Optional(
      openObject(
        'Parameters for the lane’s worker. Declared params are validated against their ' +
          'descriptors; undeclared keys ride along untouched.',
      ),
    ),
  },
  { title: 'CreateTaskRequest' },
);

/** GET /api/v1/tasks querystring. `from`/`to` filter on `created_at`. */
export const listTasksQuerySchema = Type.Object(
  {
    status: Type.Optional(taskStatusSchema),
    lane: Type.Optional(Type.String({ example: 'scrape', description: 'Filter by lane' })),
    from: Type.Optional(
      Type.String({
        format: 'date-time',
        example: ISO_EXAMPLE,
        description: 'Only tasks created at or after this instant (ISO 8601)',
      }),
    ),
    to: Type.Optional(
      Type.String({
        format: 'date-time',
        example: ISO_EXAMPLE,
        description: 'Only tasks created at or before this instant (ISO 8601)',
      }),
    ),
    sort: Type.Optional(
      Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
        description: 'By creation time. Defaults to `desc` — newest first.',
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, example: 20 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, example: 0 })),
  },
  { title: 'ListTasksQuery' },
);

/** `/tasks/:handle` params. */
export const taskHandleParamsSchema = Type.Object({
  handle: Type.String({
    example: 'scrape-1',
    description: 'The task handle, `<lane>-<n>`',
  }),
});

/** `/tasks/id/:id` params. */
export const taskIdParamsSchema = Type.Object({
  id: Type.String({
    format: 'uuid',
    example: '2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
    description: "Task's id",
  }),
});

/** GET /api/v1/tasks/stats — every status is present, zeroed when it has no rows. */
export const taskStatsResponseSchema = Type.Object(
  {
    queued: Type.Integer({ example: 3 }),
    running: Type.Integer({ example: 2 }),
    ready: Type.Integer({ example: 11 }),
    failed: Type.Integer({ example: 1 }),
    cancelled: Type.Integer({ example: 0 }),
  },
  { title: 'TaskStatsResponse' },
);

/** One row of a task's transition log. */
export const taskEventResponseSchema = Type.Object(
  {
    id: Type.Integer({
      example: 42,
      description: 'Monotonic per database. Doubles as the SSE cursor.',
    }),
    type: Type.String({
      example: 'ready',
      description:
        'accepted | started | ready | failed | cancelled, plus informational types ' +
        '(retry_scheduled, requeued_on_restart, lease_expired, collected, retry_requested)',
    }),
    at: Type.String({ example: ISO_EXAMPLE, description: 'When the transition was recorded' }),
    detail: openObject('Type-specific context: the reason, the attempt number, the backoff…'),
  },
  { title: 'TaskEventResponse' },
);

export const taskHistoryResponseSchema = Type.Array(taskEventResponseSchema, {
  title: 'TaskHistoryResponse',
});

/** One parameter a lane understands — enough for a UI to render an input for it. */
export const laneParamResponseSchema = Type.Object(
  {
    name: Type.String({ example: 'duration_ms' }),
    type: Type.Union([Type.Literal('number'), Type.Literal('boolean'), Type.Literal('string')]),
    required: Type.Boolean({ example: false }),
    default: Type.Optional(Type.Unknown({ description: 'Applied when the caller omits it' })),
    description: Type.Optional(Type.String()),
    min: Type.Optional(Type.Number({ description: 'Inclusive lower bound, numbers only' })),
    max: Type.Optional(Type.Number({ description: 'Inclusive upper bound, numbers only' })),
  },
  { title: 'LaneParam' },
);

export const laneResponseSchema = Type.Object(
  {
    lane: Type.String({ example: 'scrape' }),
    kind: Type.String({ example: 'inline', description: 'How the worker is dispatched' }),
    description: Type.Optional(Type.String({ example: 'Simulated page scrape.' })),
    params: Type.Array(laneParamResponseSchema),
  },
  { title: 'LaneResponse' },
);

export const lanesResponseSchema = Type.Array(laneResponseSchema, { title: 'LanesResponse' });

/** GET /api/v1/events querystring. */
export const eventsQuerySchema = Type.Object(
  {
    since: Type.Optional(
      Type.Integer({
        minimum: 0,
        example: 0,
        description:
          'Replay every event after this id before streaming live ones. A browser sends the ' +
          '`Last-Event-ID` header instead and does not need this; it is here so a curl client ' +
          'can replay too. The header wins when both are present.',
      }),
    ),
  },
  { title: 'EventsQuery' },
);

export function toTaskResponse(task: Task): TaskResponse {
  return {
    id: task.id,
    handle: task.handle,
    lane: task.lane,
    params: task.params,
    status: task.status,
    result: task.status === 'ready' ? (task.result ?? null) : null,
    error: task.status === 'failed' ? task.error : null,
    attempts: task.attempts,
    collected: task.collected,
    is_seed: task.isSeed,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

export function toTaskEventResponse(
  event: TaskEventWithTask,
): Static<typeof taskEventResponseSchema> {
  return {
    id: event.id,
    type: event.type,
    at: event.at.toISOString(),
    detail: event.detail,
  };
}

export function toLaneResponse(info: LaneInfo): Static<typeof laneResponseSchema> {
  return {
    lane: info.lane,
    kind: info.kind,
    description: info.description,
    params: info.params.map((param) => ({
      name: param.name,
      type: param.type,
      required: param.required,
      default: param.default,
      description: param.description,
      min: param.min,
      max: param.max,
    })),
  };
}

/**
 * `?from=`/`?to=` -> `Date`.
 *
 * The schema already declares `format: 'date-time'`, but format assertion depends on the Ajv
 * formats plugin being present, and a `WHERE "createdAt" >= 'Invalid Date'` is a 500 rather than
 * the 400 it deserves. Two lines here make the 400 unconditional.
 */
export function parseIsoDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`Query parameter "${field}" must be an ISO 8601 date-time`);
  }
  return date;
}
