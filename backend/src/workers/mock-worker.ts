import type { Worker, WorkerDescriptor } from '#src/engine/workers/types.ts';

/**
 * The stand-in for real work. It sleeps for a while and then either succeeds or fails, which is
 * enough to exercise every path in the runner: concurrency limits, leases, cancellation, retries.
 *
 * It is registered under two lanes so that handle allocation is visibly per-lane — `scrape-1` and
 * `report-1` must be able to exist at the same time.
 *
 * It lives in `src/workers/`, outside the engine: `src/engine/` is machinery and knows no lanes,
 * while a concrete worker is domain content. Whoever constructs the engine passes these in.
 */

const MIN_DURATION_MS = 3000; // 3 sec
const MAX_DURATION_MS = 15_000; // 15 sec
/** Nothing legitimate sleeps for five minutes; past this it is a typo or an attack. */
const DURATION_CAP_MS = 300_000; // 5 mins

/**
 * `setTimeout` that loses to its `AbortSignal`.
 *
 * The timer is cleared on abort, otherwise a cancelled 15-second job keeps the event loop alive
 * for the full 15 seconds and `stop({ drain: true })` cannot finish inside its budget. The abort
 * listener is registered `once` and removed on the happy path so a long-lived signal does not
 * accumulate listeners.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function pickDuration(raw: unknown): number {
  return typeof raw === 'number'
    ? raw
    : Math.floor(MIN_DURATION_MS + Math.random() * (MAX_DURATION_MS - MIN_DURATION_MS));
}

const mockHandler: Worker = async (job, ctx) => {
  const durationMs = pickDuration(job.params.duration_ms);
  await abortableSleep(durationMs, ctx.signal);

  if (job.params.fail === true) {
    // Retryable on purpose: this is the interesting case. It lets a test watch the backoff
    // schedule run and the attempt budget drain, which a permanent failure would not.
    return {
      status: 'failed',
      error: { reason: 'simulated failure', retryable: true },
    };
  }

  return {
    status: 'ready',
    result: {
      lane: job.lane,
      handle: job.handle,
      durationMs,
      finishedAt: new Date().toISOString(),
    },
  };
};

const mockParams = [
  {
    name: 'duration_ms',
    type: 'number',
    required: false,
    min: 0,
    max: DURATION_CAP_MS,
    description: `How long the job pretends to work. Defaults to a random ${MIN_DURATION_MS}–${MAX_DURATION_MS}ms.`,
  },
  {
    name: 'fail',
    type: 'boolean',
    required: false,
    default: false,
    description: 'Fail with a retryable error instead of succeeding.',
  },
] as const satisfies WorkerDescriptor['params'];

function describe(lane: string, description: string): WorkerDescriptor {
  return {
    lane,
    kind: 'inline',
    handler: mockHandler,
    params: [...mockParams],
    description,
  };
}

/** Pass these in: `createEngine({ workers: mockWorkers })`. There is no default worker set. */
export const mockWorkers: WorkerDescriptor[] = [
  describe('scrape', 'Simulated page scrape.'),
  describe('report', 'Simulated report build.'),
];
