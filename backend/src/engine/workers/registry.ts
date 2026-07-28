import type { LaneInfo, ParamDescriptor, WorkerDescriptor } from '#src/engine/types.ts';
import { BadRequestError } from '#src/lib/errors.ts';

/**
 * Maps a lane name to the code that runs it, and validates the parameters a submitter sent.
 *
 * The registry is the seam where a future `kind: 'thread' | 'external'` gets dispatched — today
 * every descriptor is `inline` and the runner simply calls `handler`, but callers already ask the
 * registry for a descriptor rather than for a function, so adding a second kind is a change here
 * and nowhere else.
 */
export interface WorkerRegistry {
  get(lane: string): WorkerDescriptor;
  list(): LaneInfo[];
  has(lane: string): boolean;
  /** Returns normalised params, or throws `BadRequestError` naming what was wrong. */
  validateParams(lane: string, params: Record<string, unknown>): Record<string, unknown>;
}

export function createWorkerRegistry(descriptors: WorkerDescriptor[]): WorkerRegistry {
  const byLane = new Map(descriptors.map((descriptor) => [descriptor.lane, descriptor]));
  const known = [...byLane.keys()].sort().join(', ');

  const get = (lane: string): WorkerDescriptor => {
    const descriptor = byLane.get(lane);
    if (!descriptor) {
      throw new BadRequestError(`Unknown lane "${lane}". Known lanes: ${known}`);
    }
    return descriptor;
  };

  return {
    get,
    has: (lane) => byLane.has(lane),
    list: () => [...byLane.values()].map(({ handler: _handler, ...info }) => info),
    validateParams(lane, params) {
      const descriptor = get(lane);
      const normalised: Record<string, unknown> = { ...params };

      for (const spec of descriptor.params) {
        const value = params[spec.name];
        if (value === undefined || value === null) {
          applyMissing(normalised, spec, lane);
        } else {
          normalised[spec.name] = coerce(value, spec, lane);
        }
      }

      return normalised;
    },
  };
}

/**
 * Undeclared parameters are passed through untouched rather than rejected.
 *
 * The strict reading — reject anything the worker did not declare — catches typos, but it also
 * makes `params` useless as a place to hang caller metadata, and the jsonb column exists precisely
 * so arbitrary payloads survive a round trip. Declared params are validated strictly; the rest
 * ride along.
 */
function applyMissing(target: Record<string, unknown>, spec: ParamDescriptor, lane: string): void {
  if (spec.default !== undefined) {
    target[spec.name] = spec.default;
    return;
  }
  if (spec.required) {
    throw new BadRequestError(`Lane "${lane}" requires parameter "${spec.name}" (${spec.type})`);
  }
  delete target[spec.name];
}

function coerce(value: unknown, spec: ParamDescriptor, lane: string): unknown {
  switch (spec.type) {
    case 'number':
      return coerceNumber(value, spec, lane);
    case 'boolean':
      return coerceBoolean(value, spec, lane);
    default:
      if (typeof value !== 'string') {
        throw new BadRequestError(reject(lane, spec, 'a string', value));
      }
      return value;
  }
}

function coerceNumber(value: unknown, spec: ParamDescriptor, lane: string): number {
  // Numeric strings are accepted because query strings and form posts have no number type;
  // rejecting "500" here would push the same coercion into every caller.
  const num = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(num)) {
    throw new BadRequestError(reject(lane, spec, 'a number', value));
  }
  if (spec.min !== undefined && num < spec.min) {
    throw new BadRequestError(`Parameter "${spec.name}" on lane "${lane}" must be >= ${spec.min}`);
  }
  if (spec.max !== undefined && num > spec.max) {
    throw new BadRequestError(`Parameter "${spec.name}" on lane "${lane}" must be <= ${spec.max}`);
  }
  return num;
}

function coerceBoolean(value: unknown, spec: ParamDescriptor, lane: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  throw new BadRequestError(reject(lane, spec, 'a boolean', value));
}

const reject = (lane: string, spec: ParamDescriptor, expected: string, got: unknown): string =>
  `Parameter "${spec.name}" on lane "${lane}" must be ${expected}, got ${JSON.stringify(got)}`;
