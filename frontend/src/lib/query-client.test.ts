import { MutationObserver } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeQueryClient } from '@/lib/query-client';
import { useUiStore } from '@/lib/stores/ui-store';

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

/** Runs a failing mutation to completion and returns the resulting snackbar. */
async function failWith(error: AxiosError, meta?: Record<string, unknown>) {
  const client = makeQueryClient();
  const observer = new MutationObserver(client, {
    mutationFn: async () => {
      throw error;
    },
    meta,
  });
  await observer.mutate().catch(() => {});
  return useUiStore.getState().snackbar;
}

describe('makeQueryClient mutation errors', () => {
  beforeEach(() => {
    useUiStore.setState({ snackbar: { open: false, message: '', severity: 'info' } });
  });

  it('still toasts when the mutation defines its own onError, and toasts first', async () => {
    const client = makeQueryClient();
    let ownHandlerRan = false;
    let snackbarWasOpenByThen = false;

    const observer = new MutationObserver(client, {
      mutationFn: async () => {
        throw apiError(409, 'Task is already collected');
      },
      onError: () => {
        ownHandlerRan = true;
        // The cache handler has already run if the toast is up by now.
        snackbarWasOpenByThen = useUiStore.getState().snackbar.open;
      },
    });
    await observer.mutate().catch(() => {});

    // Both fire, cache first. If this ever flips, the suppress flag below stops
    // being necessary — and every page that relied on it starts double-handling.
    expect(ownHandlerRan).toBe(true);
    expect(snackbarWasOpenByThen).toBe(true);
    expect(useUiStore.getState().snackbar.open).toBe(true);
  });

  it('shows the backend message verbatim for a 4xx', async () => {
    const snackbar = await failWith(apiError(409, 'Task is already collected'));

    expect(snackbar.open).toBe(true);
    expect(snackbar.message).toBe('Task is already collected');
    expect(snackbar.severity).toBe('error');
  });

  it('stays silent when meta.suppressErrorToast is true', async () => {
    const snackbar = await failWith(apiError(409, 'Task is already collected'), {
      suppressErrorToast: true,
    });

    expect(snackbar.open).toBe(false);
  });

  it('suppresses only what the predicate matches', async () => {
    const only409 = (error: unknown) => (error as AxiosError).response?.status === 409;

    expect(
      (await failWith(apiError(409, 'Already collected'), { suppressErrorToast: only409 })).open,
    ).toBe(false);
    expect(
      (await failWith(apiError(404, 'No such task'), { suppressErrorToast: only409 })).open,
    ).toBe(true);
  });
});
