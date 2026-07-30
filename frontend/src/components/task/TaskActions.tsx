'use client';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import { useMutation } from '@tanstack/react-query';
import { collectTaskResult, useCancelTask, useRetryTask } from '@/lib/api/endpoints/tasks/tasks';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api/errors';
import type { TaskResponse } from '@/lib/api/model';
import { useDialog } from '@/lib/ui-hooks/useDialog';
import { canCancel, canCollect, canRetry } from '@/lib/utils/task-actions';

interface TaskActionsProps {
  task: TaskResponse;
  /** Called with the server's fresh copy of the task after an action succeeds. */
  onDone: (updated: TaskResponse) => void;
  onRefresh: () => void;
}

/**
 * A 409 carries the engine's own account of why the transition was refused, which
 * beats anything this page could compose. It is shown inline instead of toasted
 * because it describes the row on screen; every other failure still toasts.
 */
const SUPPRESS_CONFLICT_TOAST = {
  suppressErrorToast: (error: unknown) => apiErrorStatus(error) === 409,
};

export default function TaskActions({ task, onDone, onRefresh }: TaskActionsProps) {
  const confirmCancel = useDialog();

  const cancel = useCancelTask({
    mutation: {
      meta: SUPPRESS_CONFLICT_TOAST,
      onSuccess: (updated) => {
        confirmCancel.handleClose();
        onDone(updated);
      },
      onError: () => confirmCancel.handleClose(),
    },
  });

  const retry = useRetryTask({
    mutation: { meta: SUPPRESS_CONFLICT_TOAST, onSuccess: (updated) => onDone(updated) },
  });

  /**
   * Collect is a GET that transitions the task, so Orval generated it as a query
   * hook. Mounting that hook would collect the task just by rendering this page,
   * and re-collect on every SSE-driven invalidation. The raw function wrapped in a
   * mutation is the only safe way to call it.
   */
  const collect = useMutation({
    mutationFn: (handle: string) => collectTaskResult(handle),
    meta: SUPPRESS_CONFLICT_TOAST,
    onSuccess: (updated) => onDone(updated),
  });

  const conflict = [collect.error, cancel.error, retry.error].find(
    (error) => apiErrorStatus(error) === 409,
  );

  const clearConflict = () => {
    collect.reset();
    cancel.reset();
    retry.reset();
  };

  const dismissing = task.status === 'failed';
  const busy = collect.isPending || cancel.isPending || retry.isPending;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {canCollect(task) ? (
          <Button
            variant="contained"
            loading={collect.isPending}
            disabled={busy && !collect.isPending}
            onClick={() => {
              clearConflict();
              collect.mutate(task.handle);
            }}
          >
            Collect result
          </Button>
        ) : null}

        {canRetry(task) ? (
          <Button
            variant="outlined"
            loading={retry.isPending}
            disabled={busy && !retry.isPending}
            onClick={() => {
              clearConflict();
              retry.mutate({ handle: task.handle });
            }}
          >
            Retry
          </Button>
        ) : null}

        {canCancel(task) ? (
          <Button
            variant="outlined"
            color="error"
            disabled={busy}
            onClick={() => {
              clearConflict();
              confirmCancel.handleOpen();
            }}
          >
            {dismissing ? 'Dismiss' : 'Cancel'}
          </Button>
        ) : null}
      </Stack>

      {conflict ? (
        <Alert
          severity="warning"
          onClose={clearConflict}
          action={
            <Button color="inherit" size="small" onClick={onRefresh}>
              Refresh
            </Button>
          }
        >
          <AlertTitle>That is no longer possible</AlertTitle>
          {apiErrorMessage(conflict)}
        </Alert>
      ) : null}

      <Dialog open={confirmCancel.open} onClose={confirmCancel.handleClose} maxWidth="xs" fullWidth>
        <DialogTitle>
          {dismissing ? `Dismiss ${task.handle}?` : `Cancel ${task.handle}?`}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {dismissing
              ? 'The failed task is closed out and its handle number is released for reuse. It cannot be retried afterwards.'
              : 'A running worker is aborted rather than left to finish, and the handle number is released for reuse. This cannot be undone.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={confirmCancel.handleClose}>Keep it</Button>
          <Button
            color="error"
            variant="contained"
            loading={cancel.isPending}
            onClick={() => cancel.mutate({ handle: task.handle })}
          >
            {dismissing ? 'Dismiss' : 'Cancel task'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
