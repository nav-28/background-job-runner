import { EventEmitter } from 'node:events';
import {
  type EngineEvent,
  type EngineEventBase,
  type EngineLogger,
  type EventBus,
  TaskEventType,
  type TaskEventWithTask,
} from '#src/engine/types.ts';

export type { EventBus } from '#src/engine/types.ts';

export function handleOf(lane: string, handleNum: number): string {
  return `${lane}-${handleNum}`;
}

/**
 * In-process fan-out, one EventEmitter channel per user id.
 *
 */
export class InProcessEventBus implements EventBus {
  private readonly emitter = new EventEmitter();
  private readonly logger: EngineLogger;

  constructor(logger: EngineLogger) {
    this.logger = logger;
    // One listener per open subscription; the default cap of 10 would warn on an ordinary user
    // with a few browser tabs open.
    this.emitter.setMaxListeners(0);
  }

  publish = (event: EngineEvent): void => {
    this.emitter.emit(event.user_id, event);
  };

  subscribe = (userId: string, cb: (e: EngineEvent) => void): (() => void) => {
    // A subscriber that throws must not be able to take down the runner mid-transition, so it is
    // isolated — but isolated is not the same as ignored. It is reported at `error`: a subscriber
    // throwing is a bug in the subscriber, and one nobody can find if the bus eats it.
    const guarded = (event: EngineEvent) => {
      try {
        cb(event);
      } catch (error: unknown) {
        this.logger.error(
          {
            err: error,
            userId,
            eventId: event.id,
            eventType: event.type,
            handle: event.handle,
          },
          'engine: event subscriber threw; other subscribers are unaffected',
        );
      }
    };
    this.emitter.on(userId, guarded);
    return () => {
      this.emitter.off(userId, guarded);
    };
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function toEngineEvent(row: TaskEventWithTask): EngineEvent {
  const base: EngineEventBase = {
    id: row.id,
    task_id: row.taskId,
    user_id: row.userId,
    handle: handleOf(row.lane, row.handleNum),
    lane: row.lane,
  };

  switch (row.type) {
    case TaskEventType.accepted:
    case TaskEventType.ready:
      return { ...base, type: row.type, summary: asString(row.detail.summary) };
    case TaskEventType.failed:
      return {
        ...base,
        type: TaskEventType.failed,
        reason: asString(row.detail.reason, 'unknown failure'),
        retryable: row.detail.retryable === true,
      };
    case TaskEventType.cancelled:
      return { ...base, type: TaskEventType.cancelled };
    default:
      return { ...base, type: row.type, detail: row.detail };
  }
}
