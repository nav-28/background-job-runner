'use client';

import CloseIcon from '@mui/icons-material/Close';
import FilterListIcon from '@mui/icons-material/FilterList';
import TableRowsIcon from '@mui/icons-material/TableRows';
import ViewModuleIcon from '@mui/icons-material/ViewModule';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import { useTheme } from '@mui/material/styles';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useMemo, useState } from 'react';
import StatsStrip from '@/components/dashboard/StatsStrip';
import SubmitTaskDialog from '@/components/dashboard/SubmitTaskDialog';
import TaskCard from '@/components/dashboard/TaskCard';
import TaskFilterBar from '@/components/dashboard/TaskFilterBar';
import TaskTable from '@/components/dashboard/TaskTable';
import ErrorState from '@/components/ErrorState';
import { useListLanes, useListTasks, useTaskStats } from '@/lib/api/endpoints/tasks/tasks';
import type { TaskStatus } from '@/lib/api/model';
import { useDialog } from '@/lib/ui-hooks/useDialog';
import { type TaskViewMode, useTaskViewMode } from '@/lib/ui-hooks/useTaskViewMode';
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  INITIAL_LIMIT,
  isFiltered,
  LIMIT_STEP,
  MAX_LIMIT,
  type TaskFilterState,
  toListTasksParams,
} from '@/lib/utils/task-filters';

export default function DashboardPage() {
  const [filters, setFilters] = useState<TaskFilterState>(DEFAULT_FILTERS);
  const [limit, setLimit] = useState(INITIAL_LIMIT);

  const submitDialog = useDialog();
  const filterDrawer = useDialog();

  const theme = useTheme();
  const viewMode = useTaskViewMode();

  const isDesktop = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  const showTable = viewMode.ready && isDesktop && viewMode.mode === 'table';

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

  const filterBar = (
    <TaskFilterBar filters={filters} lanes={lanes.data ?? []} onChange={applyFilters} />
  );

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h1" sx={{ flexGrow: 1 }}>
          Tasks
        </Typography>

        <ToggleButtonGroup
          size="small"
          exclusive
          value={viewMode.mode}
          onChange={(_event, next: TaskViewMode | null) => {
            if (next) viewMode.setMode(next);
          }}
          aria-label="View"
          sx={{ display: { xs: 'none', md: 'inline-flex' } }}
        >
          <ToggleButton value="cards" aria-label="Card view">
            <Tooltip title="Cards">
              <ViewModuleIcon fontSize="small" />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="table" aria-label="Table view">
            <Tooltip title="Table">
              <TableRowsIcon fontSize="small" />
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>

        <Button variant="contained" onClick={() => submitDialog.handleOpen()}>
          Submit task
        </Button>
      </Stack>

      <StatsStrip stats={stats.data} active={filters.status} onToggle={toggleStatus} />

      <Box sx={{ display: { xs: 'none', md: 'block' } }}>{filterBar}</Box>

      <Box sx={{ display: { xs: 'block', md: 'none' } }}>
        <Badge badgeContent={activeFilterCount(filters)} color="primary">
          <Button
            variant="outlined"
            startIcon={<FilterListIcon />}
            onClick={() => filterDrawer.handleOpen()}
          >
            Filters
          </Button>
        </Badge>
      </Box>

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
        ) : showTable ? (
          <TaskTable tasks={rows} />
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

      <Drawer anchor="bottom" open={filterDrawer.open} onClose={filterDrawer.handleClose}>
        <Box sx={{ p: 2 }}>
          <Stack direction="row" sx={{ alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" component="p" sx={{ flexGrow: 1 }}>
              Filters
            </Typography>
            <IconButton onClick={filterDrawer.handleClose} aria-label="Close filters">
              <CloseIcon />
            </IconButton>
          </Stack>
          {filterBar}
        </Box>
      </Drawer>

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
