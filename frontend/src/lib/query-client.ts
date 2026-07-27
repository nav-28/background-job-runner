import { QueryClient } from '@tanstack/react-query';

/**
 * Factory for a per-app QueryClient. Created inside a `useState` initializer in
 * the provider so each browser tab / SSR request gets its own instance.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
