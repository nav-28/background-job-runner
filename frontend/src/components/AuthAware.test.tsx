import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSnackbarStore } from '@/components/GlobalSnackbar/store';
import { makeQueryClient } from '@/lib/query-client';

/**
 * The one behaviour worth pinning here is that a 401 and an unreachable backend
 * take completely different paths. They are indistinguishable if you only look
 * at `isError`, and getting it wrong either shows a scary error page to someone
 * who merely needs to sign in, or silently bounces someone to /login when the
 * API is simply down.
 */

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

// The generated auth client's only runtime import. Mocking it keeps the real
// hook, the real query client and the real `errors.ts` in the test.
const { customInstance } = vi.hoisted(() => ({ customInstance: vi.fn() }));
vi.mock('@/lib/api/api-client', () => ({ customInstance }));

// Imported after the mocks so the generated module picks up the stub.
const { default: AuthAware } = await import('./AuthAware');

const config = { headers: {} } as InternalAxiosRequestConfig;

function httpError(status: number, message: string): AxiosError {
  const response = { status, data: { statusCode: status, message }, config } as AxiosResponse;
  return new AxiosError(message, 'ERR_BAD_REQUEST', config, {}, response);
}

/** No `response` at all — what axios produces when the API is not listening. */
function networkError(): AxiosError {
  return new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {});
}

function renderGuarded() {
  const queryClient = makeQueryClient();
  // Keep the real retry *predicate* (that is what makes a 401 fail fast) but
  // drop the exponential backoff so the network case does not take a second.
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return render(<AuthAware>protected content</AuthAware>, { wrapper });
}

describe('<AuthAware />', () => {
  beforeEach(() => {
    replace.mockClear();
    customInstance.mockReset();
  });

  afterEach(() => {
    useSnackbarStore.setState({ snackbars: [] });
  });

  it('renders children once the session resolves', async () => {
    customInstance.mockResolvedValue({
      user: { id: 'u1', email: 'demo@example.com', name: 'Demo' },
      kind: 'session',
    });

    renderGuarded();

    expect(await screen.findByText('protected content')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects to /login on a 401 instead of showing an error', async () => {
    customInstance.mockRejectedValue(httpError(401, 'Unauthorized'));

    renderGuarded();

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    // A signed-out user is not an error, so nothing may be toasted either.
    expect(useSnackbarStore.getState().snackbars).toHaveLength(0);
  });

  it('shows ErrorState, and does not redirect, when the API is unreachable', async () => {
    customInstance.mockRejectedValue(networkError());

    renderGuarded();

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Cannot reach the API. Is the backend running?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
