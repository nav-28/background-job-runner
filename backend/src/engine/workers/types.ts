export interface Job {
  handle: string;
  lane: string;
  params: Record<string, unknown>;
}

export interface WorkerResult {
  status: 'ready' | 'failed';
  result?: unknown;
  error?: { reason: string; retryable: boolean };
}

export interface WorkerContext {
  signal: AbortSignal;
}

export type Worker = (job: Job, ctx: WorkerContext) => Promise<WorkerResult>;

/**
 * Describes one parameter a worker understands. Used for validation and for `lanes()`, which is
 * how a UI can render a form without hard-coding anything about a lane.
 *
 * `min`/`max` are a small addition over the spec's field list: the mock worker has to cap
 * `duration_ms` at 300000, and a bound that lives in the descriptor is discoverable by `lanes()`
 * whereas one buried in the handler is not.
 */
export interface ParamDescriptor {
  name: string;
  type: 'number' | 'boolean' | 'string';
  required: boolean;
  default?: unknown;
  description?: string;
  min?: number;
  max?: number;
}

export interface WorkerDescriptor {
  lane: string;
  /**
   * A union of one member today. Everything dispatches on the event loop; 'thread' | 'external'
   * land here later, and the registry already switches on this field rather than assuming.
   */
  kind: 'inline';
  handler: Worker;
  params: ParamDescriptor[];
  description?: string;
}

export type LaneInfo = Omit<WorkerDescriptor, 'handler'>;
