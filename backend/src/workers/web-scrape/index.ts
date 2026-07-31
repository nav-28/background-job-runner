import { Buffer } from 'node:buffer';
import type { Job, Worker, WorkerDescriptor, WorkerResult } from '#src/engine/workers/types.ts';
import { extractPage } from '#src/workers/web-scrape/html-extract.ts';
import { guardUrl } from '#src/workers/web-scrape/url-guard.ts';

const LANE = 'web-scrape';
const MAX_BYTES = 2 * 1024 * 1024;

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30_000;
const USER_AGENT = 'job-runner/1.0 (+https://github.com/nav-28/web-app-template)';

interface Failure {
  reason: string;
  retryable: boolean;
}

function failed(error: Failure): WorkerResult {
  return { status: 'failed', error };
}

/**
 * `retryable` is a claim about the nature of the error, and both mistakes cost something:
 * retrying a 404 burns the attempt budget for nothing, and failing a connection reset permanently
 * throws away work that would have succeeded on the next try.
 */
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function createScrapeWorker(): WorkerDescriptor {
  return {
    lane: LANE,
    kind: 'inline',
    handler: makeHandler(),
    params: [
      {
        name: 'url',
        type: 'string',
        required: true,
        description:
          'Absolute http(s) URL of a public page. Private and internal hosts are refused.',
      },
      {
        name: 'timeout_ms',
        type: 'number',
        required: false,
        default: DEFAULT_TIMEOUT_MS,
        min: MIN_TIMEOUT_MS,
        max: MAX_TIMEOUT_MS,
        description: 'Budget for the whole scrape — every redirect hop and the body read.',
      },
    ],
    description: 'Fetch a public web page and report its title, description, headline and links.',
  };
}

function makeHandler(): Worker {
  return async (job, ctx) => {
    const startedAt = Date.now();
    const url = typeof job.params.url === 'string' ? job.params.url : '';
    // One deadline for the whole scrape, not per hop, so a redirect chain cannot multiply it.
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutOf(job))]);

    try {
      return await scrape(url, signal, startedAt);
    } catch (error: unknown) {
      // An engine cancellation is not this worker's failure to report: the runner has already
      // written the terminal state and swallows whatever comes back. Let it propagate.
      if (ctx.signal.aborted) {
        throw error;
      }
      return failed(classifyThrown(error, timeoutOf(job)));
    }
  };
}

function timeoutOf(job: Job): number {
  const raw = job.params.timeout_ms;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(raw, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

async function scrape(url: string, signal: AbortSignal, startedAt: number): Promise<WorkerResult> {
  const hop = await follow(url, signal);
  if ('reason' in hop) {
    return failed(hop);
  }

  const rejection = rejectResponse(hop.response);
  if (rejection) {
    await hop.response.body?.cancel();
    return failed(rejection);
  }

  const body = await readCapped(hop.response);
  if (!body) {
    return failed({
      reason: `Response exceeded the ${MAX_BYTES}-byte limit`,
      retryable: false,
    });
  }

  return {
    status: 'ready',
    result: {
      url,
      final_url: hop.response.url || hop.url.toString(),
      status: hop.response.status,
      ...extractPage(body.text),
      bytes: body.bytes,
      duration_ms: Date.now() - startedAt,
    },
  };
}

interface Hop {
  response: Response;
  url: URL;
}

/**
 * REDIRECTS ARE RE-VALIDATED, WHICH IS WHY `fetch` IS NOT ALLOWED TO FOLLOW THEM.
 *
 * `redirect: 'follow'` (the default) would let a perfectly public URL bounce the server to
 * `http://169.254.169.254/` with the guard none the wiser, because it only ever sees the URL that
 * was submitted. Every hop goes through `guardUrl` again.
 */
async function follow(target: string, signal: AbortSignal): Promise<Hop | Failure> {
  let next = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await guardUrl(next);
    if (!verdict.ok) {
      return { reason: verdict.reason, retryable: verdict.retryable };
    }

    const response = await fetch(verdict.url, {
      redirect: 'manual',
      signal,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
    });

    const location = isRedirect(response.status) ? response.headers.get('location') : null;
    if (location === null) {
      return { response, url: verdict.url };
    }

    await response.body?.cancel();
    try {
      next = new URL(location, verdict.url).toString();
    } catch {
      return { reason: `Redirect to an unreadable location "${location}"`, retryable: false };
    }
  }

  return { reason: `More than ${MAX_REDIRECTS} redirects`, retryable: false };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function rejectResponse(response: Response): Failure | null {
  const { status } = response;
  if (status === 429 || status >= 500) {
    return { reason: `Server returned HTTP ${status}`, retryable: true };
  }
  if (status < 200 || status >= 300) {
    return { reason: `Server returned HTTP ${status}`, retryable: false };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.split(';')[0].trim().toLowerCase().startsWith('text/html')) {
    return {
      reason: `Expected text/html, got "${contentType || 'no content type'}"`,
      retryable: false,
    };
  }
  return null;
}

/**
 * Reads at most `MAX_BYTES` and then drops the connection.
 *
 * A `Content-Length` check is not a substitute: chunked responses omit it and a hostile one can
 * simply lie. Returns null when the cap is hit, having read nothing beyond it.
 */
async function readCapped(response: Response): Promise<{ bytes: number; text: string } | null> {
  if (!response.body) {
    return { bytes: 0, text: '' };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  let chunk = await reader.read();
  while (!chunk.done) {
    bytes += chunk.value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
    chunk = await reader.read();
  }

  return { bytes, text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

function classifyThrown(error: unknown, timeoutMs: number): Failure {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { reason: `Timed out after ${timeoutMs}ms`, retryable: true };
  }

  const code = error instanceof Error ? codeOf(error) : undefined;
  if (code !== undefined && RETRYABLE_CODES.has(code)) {
    return { reason: `Could not reach the host (${code})`, retryable: true };
  }

  // Assume transient. A network error we cannot name is far more often a blip than a permanent
  // condition, and the attempt budget bounds the cost of being wrong.
  const message = error instanceof Error ? error.message : String(error);
  return { reason: `Fetch failed: ${message}`, retryable: true };
}

/** undici hides the syscall error one or two `cause` levels down. */
function codeOf(error: Error): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}
