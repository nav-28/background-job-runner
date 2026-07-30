'use client';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import { apiErrorMessage } from '@/lib/api/errors';

interface ErrorStateProps {
  /** Whatever a query/mutation failed with — usually `query.error`. */
  error: unknown;
  /** When given, renders a Retry button; usually `() => query.refetch()`. */
  onRetry?: () => void;
}

export default function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <Alert
      severity="error"
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>Something went wrong</AlertTitle>
      {apiErrorMessage(error)}
    </Alert>
  );
}
