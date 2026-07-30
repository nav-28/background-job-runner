import { MutationObserver } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSnackbarStore } from '@/components/GlobalSnackbar/store';
import { makeQueryClient } from '@/lib/query-client';

/**
 * The global mutation error contract.
 *
 * The first test here exists because the obvious reading of the API is wrong: a
 * mutation-level `onError` does NOT replace the MutationCache one, it runs after
 * it. Anything that assumes "I handled it, so no toast" is silently broken, which
 * is why opting out goes through `meta.suppressErrorToast` instead.
 */

function apiError(status: number, message: string): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError(message, String(status), { headers }, null, {
    status,
    statusText: '',
    headers,
    config: { headers },
    data: { statusCode: status, message, error: '', correlationId: 'cid-1' },
  });
}

const snackbars = () => useSnackbarStore.getState().snackbars;

/** Runs a failing mutation to completion and returns the resulting snackbar queue. */
async function failWith(error: AxiosError, meta?: Record<string, unknown>) {
  useSnackbarStore.setState({ snackbars: [] });

  const client = makeQueryClient();
  const observer = new MutationObserver(client, {
    mutationFn: async () => {
      throw error;
    },
    meta,
  });
  await observer.mutate().catch(() => {});
  return snackbars();
}

describe('makeQueryClient mutation errors', () => {
  beforeEach(() => {
    useSnackbarStore.setState({ snackbars: [] });
  });

  it('still toasts when the mutation defines its own onError, and toasts first', async () => {
    const client = makeQueryClient();
    let ownHandlerRan = false;
    let snackbarCountByThen = 0;

    const observer = new MutationObserver(client, {
      mutationFn: async () => {
        throw apiError(409, 'Task is already collected');
      },
      onError: () => {
        ownHandlerRan = true;
        // The cache handler has already run if the toast is up by now.
        snackbarCountByThen = snackbars().length;
      },
    });
    await observer.mutate().catch(() => {});

    // Both fire, cache first. If this ever flips, the suppress flag below stops
    // being necessary — and every page that relied on it starts double-handling.
    expect(ownHandlerRan).toBe(true);
    expect(snackbarCountByThen).toBe(1);
    expect(snackbars()).toHaveLength(1);
  });

  it('shows the backend message verbatim for a 4xx', async () => {
    const queue = await failWith(apiError(409, 'Task is already collected'));

    expect(queue).toHaveLength(1);
    expect(queue.at(-1)?.message).toBe('Task is already collected');
    expect(queue.at(-1)?.variant).toBe('error');
  });

  it('stays silent when meta.suppressErrorToast is true', async () => {
    const queue = await failWith(apiError(409, 'Task is already collected'), {
      suppressErrorToast: true,
    });

    expect(queue).toHaveLength(0);
  });

  it('suppresses only what the predicate matches', async () => {
    const only409 = (error: unknown) => (error as AxiosError).response?.status === 409;

    expect(
      await failWith(apiError(409, 'Already collected'), { suppressErrorToast: only409 }),
    ).toHaveLength(0);
    expect(
      await failWith(apiError(404, 'No such task'), { suppressErrorToast: only409 }),
    ).toHaveLength(1);
  });
});
