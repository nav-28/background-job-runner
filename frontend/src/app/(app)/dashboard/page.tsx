'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useMemo, useState } from 'react';
import {
  DEFAULT_FILTERS,
  INITIAL_LIMIT,
  isFiltered,
  LIMIT_STEP,
  MAX_LIMIT,
  type TaskFilterState,
  toListTasksParams,
} from '@/components/dashboard/filters';
import StatsStrip from '@/components/dashboard/StatsStrip';
import SubmitTaskDialog from '@/components/dashboard/SubmitTaskDialog';
import TaskCard from '@/components/dashboard/TaskCard';
import TaskFilterBar from '@/components/dashboard/TaskFilterBar';
import ErrorState from '@/components/ErrorState';
import { useListLanes, useListTasks, useTaskStats } from '@/lib/api/endpoints/tasks/tasks';
import type { TaskStatus } from '@/lib/api/model';
import { useTaskEvents } from '@/lib/hooks/useTaskEvents';
import { useDialog } from '@/lib/ui-hooks/useDialog';

/**
 * `EventSource` reconnects on its own, so an `error` means "retrying", never
 * "gave up". The copy has to say so or a transient blip reads as a dead app.
 */
const STREAM_LABEL: Record<ReturnType<typeof useTaskEvents>['status'], string> = {
  connecting: 'Connecting…',
  open: 'Live',
  error: 'Reconnecting…',
};

export default function DashboardPage() {
  const { status: streamStatus } = useTaskEvents({ enabled: true });

  const [filters, setFilters] = useState<TaskFilterState>(DEFAULT_FILTERS);
  const [limit, setLimit] = useState(INITIAL_LIMIT);

  const submitDialog = useDialog();

  const params = useMemo(() => toListTasksParams(filters, limit), [filters, limit]);

  const tasks = useListTasks(params);
  const stats = useTaskStats();
  const lanes = useListLanes();

  const applyFilters = (next: TaskFilterState) => {
    setFilters(next);
    setLimit(INITIAL_LIMIT);
  };

  const toggleStatus = (status: TaskStatus) =>
    applyFilters({ ...filters, status: filters.status === status ? undefined : status });

  const rows = tasks.data ?? [];
  // No total count comes back, so a full page is the only hint that more exists.
  const looksTruncated = rows.length >= limit;
  const atCap = limit >= MAX_LIMIT;

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h1" sx={{ flexGrow: 1 }}>
          Tasks
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          color={streamStatus === 'open' ? 'success' : 'default'}
          label={STREAM_LABEL[streamStatus]}
        />
        <Button variant="contained" onClick={() => submitDialog.handleOpen()}>
          Submit task
        </Button>
      </Stack>

      <StatsStrip stats={stats.data} active={filters.status} onToggle={toggleStatus} />

      <TaskFilterBar filters={filters} lanes={lanes.data ?? []} onChange={applyFilters} />

      {tasks.isError ? (
        <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : null}

      {tasks.isPending ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress aria-label="Loading tasks" />
        </Box>
      ) : null}

      {tasks.data ? (
        rows.length === 0 ? (
          <Paper variant="outlined">
            <Typography sx={{ p: 3 }} color="text.secondary">
              {isFiltered(filters)
                ? 'No tasks match these filters.'
                : 'No tasks yet. Submit one to watch it move through the engine.'}
            </Typography>
          </Paper>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: {
                xs: '1fr',
                sm: 'repeat(2, minmax(0, 1fr))',
                md: 'repeat(3, minmax(0, 1fr))',
              },
            }}
          >
            {rows.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </Box>
        )
      ) : null}

      {looksTruncated ? (
        <Stack spacing={1} sx={{ alignItems: 'center' }}>
          {atCap ? (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
              Showing the first {MAX_LIMIT} tasks — that is the most one request returns. Narrow the
              range with the filters above to see the rest.
            </Typography>
          ) : (
            <Button
              variant="outlined"
              onClick={() => setLimit((current) => Math.min(current + LIMIT_STEP, MAX_LIMIT))}
              loading={tasks.isFetching}
            >
              Load more
            </Button>
          )}
        </Stack>
      ) : null}

      <SubmitTaskDialog
        open={submitDialog.open}
        onClose={submitDialog.handleClose}
        lanes={lanes.data ?? []}
        onSubmitted={() => {
          void tasks.refetch();
          void stats.refetch();
        }}
      />
    </Stack>
  );
}
