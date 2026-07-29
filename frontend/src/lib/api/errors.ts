import axios, { type AxiosError } from 'axios';
import type { ApiErrorResponse } from '@/lib/api/model';

/**
 * Reading the backend's one error shape.
 *
 * `backend/src/plugins/error-handler.ts` sends the same body on every failure
 * path, unmatched routes included:
 *
 *   { statusCode, message, error, correlationId, subErrors? }
 *
 * Orval types generated hook errors as `ErrorType<E> = AxiosError<E>` (see
 * api-client.ts), so everything here starts from an `AxiosError` and narrows.
 */

/** Shown when axios never got a response at all. */
const NETWORK_MESSAGE = 'Cannot reach the API. Is the backend running?';

/** Shown for any 5xx — server internals never reach the client, by design. */
const SERVER_MESSAGE = 'Something went wrong on the server.';

const FALLBACK_MESSAGE = 'Something went wrong.';

export function isApiError(e: unknown): e is AxiosError<ApiErrorResponse> {
  return axios.isAxiosError(e);
}

/**
 * Narrows `response.data`, which is NOT guaranteed to be the documented object:
 * a proxy or load balancer in front of the API can return an HTML error page,
 * and axios hands that through as a string.
 */
function errorBody(e: unknown): Partial<ApiErrorResponse> | undefined {
  if (!isApiError(e)) return undefined;
  const data: unknown = e.response?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  return data as Partial<ApiErrorResponse>;
}

function stringField(
  body: Partial<ApiErrorResponse> | undefined,
  key: 'message' | 'subErrors' | 'correlationId',
): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** HTTP status of an API error, or `undefined` if the request never got a response. */
export function apiErrorStatus(e: unknown): number | undefined {
  return isApiError(e) ? e.response?.status : undefined;
}

/** The backend's correlation id, for quoting in a bug report or grepping the logs. */
export function apiCorrelationId(e: unknown): string | undefined {
  return stringField(errorBody(e), 'correlationId');
}

/**
 * The one string to show a user for a failed request.
 *
 * Resolution order:
 *  1. no response at all      → the backend is unreachable
 *  2. body carries subErrors  → `message — subErrors` (validation detail)
 *  3. 4xx with a body message → the backend's wording, VERBATIM
 *  4. 5xx                     → a generic line plus the correlation id
 *  5. anything else           → whatever the underlying error says
 *
 * Step 3 is deliberate. `error-handler.ts` preserves Fastify's own wording on
 * client errors, and the engine's `AppError` messages are the best error copy in
 * the system — the 409 from collecting an already-collected task says exactly
 * what went wrong. Flattening those to a generic reason phrase would throw away
 * the most useful text the app has.
 */
export function apiErrorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (!e.response) return NETWORK_MESSAGE;

    const body = errorBody(e);
    const message = stringField(body, 'message');
    const subErrors = stringField(body, 'subErrors');

    if (subErrors) {
      return message ? `${message} — ${subErrors}` : subErrors;
    }

    const status = e.response.status;

    if (status >= 400 && status < 500 && message) return message;

    if (status >= 500) {
      const correlationId = stringField(body, 'correlationId');
      return correlationId ? `${SERVER_MESSAGE} (ref: ${correlationId})` : SERVER_MESSAGE;
    }

    return e.message || FALLBACK_MESSAGE;
  }

  if (e instanceof Error) return e.message || FALLBACK_MESSAGE;

  return e === undefined || e === null ? FALLBACK_MESSAGE : String(e);
}
