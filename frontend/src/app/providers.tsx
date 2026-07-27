'use client';

import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { type ReactNode, useState } from 'react';
import GlobalSnackbar from '@/components/GlobalSnackbar';
import { makeQueryClient } from '@/lib/query-client';
import theme from '@/lib/theme';

/**
 * Client-side provider stack: MUI (SSR-safe emotion cache + theme) and
 * TanStack Query. Kept in one client component so the root layout stays a
 * server component.
 */
export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <AppRouterCacheProvider options={{ key: 'mui' }}>
      <ThemeProvider theme={theme} defaultMode="system">
        <CssBaseline />
        <QueryClientProvider client={queryClient}>
          {children}
          <GlobalSnackbar />
          <ReactQueryDevtools initialIsOpen={false} />
        </QueryClientProvider>
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
