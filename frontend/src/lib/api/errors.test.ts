import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { apiCorrelationId, apiErrorMessage, apiErrorStatus, isApiError } from '@/lib/api/errors';

const config = { headers: {} } as InternalAxiosRequestConfig;

/** Builds an AxiosError that carries a response, like a real 4xx/5xx would. */
function httpError(status: number, data: unknown, message = 'Request failed'): AxiosError {
  const response = {
    data,
    status,
    statusText: '',
    headers: {},
    config,
  } as AxiosResponse;
  return new AxiosError(message, 'ERR_BAD_REQUEST', config, {}, response);
}

/** Builds an AxiosError with no response — the backend never answered. */
function networkError(): AxiosError {
  return new AxiosError('Network Error', 'ERR_NETWORK', config, {});
}

describe('isApiError', () => {
  it('recognises an axios error', () => {
    expect(isApiError(httpError(404, {}))).toBe(true);
    expect(isApiError(networkError())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isApiError(new Error('boom'))).toBe(false);
    expect(isApiError('nope')).toBe(false);
    expect(isApiError(undefined)).toBe(false);
  });
});

describe('apiErrorStatus', () => {
  it('returns the response status', () => {
    expect(apiErrorStatus(httpError(409, {}))).toBe(409);
  });

  it('is undefined without a response or for a non-axios error', () => {
    expect(apiErrorStatus(networkError())).toBeUndefined();
    expect(apiErrorStatus(new Error('boom'))).toBeUndefined();
  });
});

describe('apiCorrelationId', () => {
  it('reads correlationId out of the backend body', () => {
    expect(apiCorrelationId(httpError(500, { correlationId: 'YevPQs' }))).toBe('YevPQs');
  });

  it('is undefined when the body has none, is malformed, or there is no response', () => {
    expect(apiCorrelationId(httpError(500, {}))).toBeUndefined();
    expect(apiCorrelationId(httpError(502, '<html>bad gateway</html>'))).toBeUndefined();
    expect(apiCorrelationId(networkError())).toBeUndefined();
    expect(apiCorrelationId(new Error('boom'))).toBeUndefined();
  });
});

describe('apiErrorMessage', () => {
  it('reports an unreachable API when there is no response', () => {
    expect(apiErrorMessage(networkError())).toBe('Cannot reach the API. Is the backend running?');
  });

  it('appends subErrors when the body carries them', () => {
    const error = httpError(400, {
      statusCode: 400,
      message: 'Validation error',
      error: 'Bad Request',
      correlationId: 'abc123',
      subErrors: '/email must match format "email"',
    });
    expect(apiErrorMessage(error)).toBe('Validation error — /email must match format "email"');
  });

  it('passes a 4xx message through verbatim', () => {
    const error = httpError(409, {
      statusCode: 409,
      message: 'Task 42 has already been collected',
      error: 'Conflict',
      correlationId: 'abc123',
    });
    expect(apiErrorMessage(error)).toBe('Task 42 has already been collected');
  });

  it('passes a 401 message through verbatim too', () => {
    const error = httpError(401, {
      statusCode: 401,
      message: 'Invalid credentials',
      error: 'Unauthorized',
      correlationId: 'zzz',
    });
    expect(apiErrorMessage(error)).toBe('Invalid credentials');
  });

  it('hides 5xx internals but surfaces the correlation id', () => {
    const error = httpError(500, {
      statusCode: 500,
      message: 'Internal Server Error',
      error: 'Internal Server Error',
      correlationId: 'YevPQs',
    });
    expect(apiErrorMessage(error)).toBe('Something went wrong on the server. (ref: YevPQs)');
  });

  it('still gives a 5xx message when there is no correlation id', () => {
    expect(apiErrorMessage(httpError(503, {}))).toBe('Something went wrong on the server.');
  });

  it('falls back for a malformed, non-object response body', () => {
    // A proxy in front of the API can answer with HTML, not the documented JSON.
    const error = httpError(404, '<html><body>Not Found</body></html>', 'Request failed with 404');
    expect(apiErrorMessage(error)).toBe('Request failed with 404');
  });

  it('falls back for a 4xx whose body carries no message', () => {
    expect(apiErrorMessage(httpError(418, {}, 'Teapot'))).toBe('Teapot');
  });

  it('uses the message of a plain Error', () => {
    expect(apiErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else, and has a fallback for empties', () => {
    expect(apiErrorMessage('just a string')).toBe('just a string');
    expect(apiErrorMessage(undefined)).toBe('Something went wrong.');
    expect(apiErrorMessage(new Error(''))).toBe('Something went wrong.');
  });
});
