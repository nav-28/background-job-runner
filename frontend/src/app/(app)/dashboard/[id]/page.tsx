'use client';

import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import ErrorState from '@/components/ErrorState';
import Section from '@/components/Section';
import JsonBlock from '@/components/task/JsonBlock';
import TaskActions from '@/components/task/TaskActions';
import TaskFailure from '@/components/task/TaskFailure';
import TaskHistoryTimeline from '@/components/task/TaskHistoryTimeline';
import TaskSummary from '@/components/task/TaskSummary';
import {
  getGetTaskByIdQueryKey,
  useGetTask,
  useGetTaskById,
  useGetTaskHistoryById,
} from '@/lib/api/endpoints/tasks/tasks';
import { apiErrorStatus } from '@/lib/api/errors';
import type { TaskResponse } from '@/lib/api/model';
import { isTaskQuery } from '@/lib/api/task-queries';
import { hasEntries } from '@/lib/utils/format-json';
import { canCancel, canCollect, canRetry } from '@/lib/utils/task-actions';
import { handleOwnership, holdsHandle } from '@/lib/utils/task-handle';

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const task = useGetTaskById(id);
  const history = useGetTaskHistoryById(id);
  const data = task.data;

  // Asks who the handle resolves to now. Only needed once the task is inactive —
  // see handleOwnership for why an active task needs no probe.
  const probeEnabled = data !== undefined && !holdsHandle(data);
  const holder = useGetTask(data?.handle ?? '', { query: { enabled: probeEnabled } });

  const ownership = data
    ? handleOwnership(data, {
        holderId: holder.data?.id,
        errorStatus: apiErrorStatus(holder.error),
      })
    : 'unverified';

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ predicate: isTaskQuery });
  }, [queryClient]);

  const applyUpdate = useCallback(
    (updated: TaskResponse) => {
      queryClient.setQueryData(getGetTaskByIdQueryKey(updated.id), updated);
      refresh();
    },
    [queryClient, refresh],
  );

  const backLink = (
    <Button component={Link} href="/dashboard" size="small" startIcon={<ArrowBackIcon />}>
      All tasks
    </Button>
  );

  // A malformed id is a 400 from the schema, not a 404, but to a reader who
  // mistyped a URL both mean the same thing.
  const missing = apiErrorStatus(task.error);
  if (missing === 404 || missing === 400) {
    return (
      <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
        {backLink}
        <Alert severity="info">
          <AlertTitle>No such task</AlertTitle>
          {missing === 404 ? (
            <>
              Nothing on this account has the id <code>{id}</code>.
            </>
          ) : (
            <>
              <code>{id}</code> is not a task id. Task pages are addressed by uuid.
            </>
          )}
        </Alert>
      </Stack>
    );
  }

  if (task.isError) {
    return (
      <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
        {backLink}
        <Box sx={{ alignSelf: 'stretch' }}>
          <ErrorState error={task.error} onRetry={() => void task.refetch()} />
        </Box>
      </Stack>
    );
  }

  if (!data) {
    return (
      <Stack spacing={2}>
        {backLink}
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress aria-label="Loading task" />
        </Box>
      </Stack>
    );
  }

  const actionable = canCollect(data) || canRetry(data) || canCancel(data);
  const failure = data.status === 'failed' ? data.error : null;

  return (
    <Stack spacing={3}>
      <Stack direction="row" sx={{ alignItems: 'center' }}>
        {backLink}
      </Stack>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <TaskSummary task={data} />
      </Paper>

      {ownership === 'reclaimed' ? (
        <Alert severity="info">
          <AlertTitle>This task has retired</AlertTitle>
          Handles are recycled: <code>{data.handle}</code> now belongs to a newer task, so the
          actions that address a task by handle no longer apply to this one. Its own details and
          timeline, below, are addressed by id and remain accurate.
        </Alert>
      ) : null}

      {ownership === 'unverified' && holder.isError ? (
        <ErrorState error={holder.error} onRetry={() => void holder.refetch()} />
      ) : null}

      {ownership === 'owned' && actionable ? (
        <Section title="Actions">
          <TaskActions task={data} onDone={applyUpdate} onRefresh={refresh} />
        </Section>
      ) : null}

      <Section title="Params">
        {hasEntries(data.params) ? (
          <JsonBlock value={data.params} />
        ) : (
          <Typography variant="body2" color="text.secondary">
            Submitted with no parameters.
          </Typography>
        )}
      </Section>

      {data.status === 'ready' && data.collected ? (
        <Section title="Result">
          {data.result === null || data.result === undefined ? (
            <Typography variant="body2" color="text.secondary">
              {data.collected
                ? 'The worker returned no payload.'
                : 'Collect the task to take delivery of its result.'}
            </Typography>
          ) : (
            <JsonBlock value={data.result} />
          )}
        </Section>
      ) : null}

      {failure ? (
        <Section title="Failure">
          <TaskFailure error={failure} />
        </Section>
      ) : null}

      <Section title="Executions">
        <Typography variant="h6" component="p">
          {data.attempts}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Lifetime count, one per claim. A manual retry grants a fresh budget without resetting
          this, so it is not a number of attempts remaining.
        </Typography>
      </Section>

      <Section
        title="History"
        action={
          history.isFetching ? <CircularProgress size={16} aria-label="Refreshing" /> : undefined
        }
      >
        {history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : history.data ? (
          <TaskHistoryTimeline events={history.data} />
        ) : (
          <CircularProgress size={20} aria-label="Loading history" />
        )}
      </Section>
    </Stack>
  );
}
