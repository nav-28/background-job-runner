'use client';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import ErrorState from '@/components/ErrorState';
import { useMe } from '@/lib/api/endpoints/auth/auth';
import { apiErrorStatus } from '@/lib/api/errors';

/**
 * The guard every authenticated page shares, mounted once by `app/(app)/layout.tsx`.
 */
export default function AuthAware({ children }: { children: ReactNode }): ReactNode {
  const router = useRouter();
  const { data, error, isPending, refetch } = useMe();

  const signedOut = apiErrorStatus(error) === 401;

  useEffect(() => {
    if (signedOut) router.replace('/login');
  }, [signedOut, router]);

  if (isPending || signedOut) return <FullHeightSpinner />;

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  if (!data) return <FullHeightSpinner />;

  return children;
}

function FullHeightSpinner() {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
      }}
    >
      <CircularProgress aria-label="Loading" />
    </Box>
  );
}
