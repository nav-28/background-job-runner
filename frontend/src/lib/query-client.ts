import { MutationCache, QueryClient } from '@tanstack/react-query';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api/errors';
import { useUiStore } from '@/lib/stores/ui-store';

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
        useUiStore.getState().notify(apiErrorMessage(error), 'error');
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
