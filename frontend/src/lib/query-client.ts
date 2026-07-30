import { MutationCache, QueryClient } from '@tanstack/react-query';
import { enqueueSnackbar } from '@/components/GlobalSnackbar/store';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api/errors';

/** The snackbar default of 3s is not enough time to read a failure. */
const ERROR_AUTO_HIDE_DURATION = 6000;

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /**
       * Suppress the default error snackbar for this mutation. `true` silences
       * every failure; a predicate silences only the ones it matches, so a page
       * can render one status inline and still toast the rest.
       */
      suppressErrorToast?: boolean | ((error: unknown) => boolean);
    };
  }
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const suppress = mutation.options.meta?.suppressErrorToast;
        if (typeof suppress === 'function' ? suppress(error) : suppress === true) {
          return;
        }
        enqueueSnackbar(apiErrorMessage(error), {
          variant: 'error',
          autoHideDuration: ERROR_AUTO_HIDE_DURATION,
        });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          const status = apiErrorStatus(error);
          if (status !== undefined && status >= 400 && status < 500) return false;
          return failureCount < 1;
        },
      },
    },
  });
}
