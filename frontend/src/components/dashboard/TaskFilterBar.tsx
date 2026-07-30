'use client';

import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { LaneResponse, TaskStatus } from '@/lib/api/model';
import { DEFAULT_FILTERS, isFiltered, type TaskFilterState } from './filters';
import { TASK_STATUSES } from './status';

interface TaskFilterBarProps {
  filters: TaskFilterState;
  lanes: LaneResponse[];
  onChange: (next: TaskFilterState) => void;
}

const ALL = '';

const fieldSx = { width: { xs: '100%', sm: 180 } } as const;

export default function TaskFilterBar({ filters, lanes, onChange }: TaskFilterBarProps) {
  const patch = (next: Partial<TaskFilterState>) => onChange({ ...filters, ...next });

  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      useFlexGap
      sx={{ flexWrap: 'wrap', alignItems: { sm: 'center' } }}
    >
      <TextField
        select
        size="small"
        label="Status"
        sx={fieldSx}
        value={filters.status ?? ALL}
        onChange={(event) =>
          patch({ status: (event.target.value as TaskStatus | typeof ALL) || undefined })
        }
      >
        <MenuItem value={ALL}>All</MenuItem>
        {TASK_STATUSES.map((status) => (
          <MenuItem key={status} value={status}>
            {status}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        select
        size="small"
        label="Lane"
        sx={fieldSx}
        disabled={lanes.length === 0}
        value={filters.lane ?? ALL}
        onChange={(event) => patch({ lane: event.target.value || undefined })}
      >
        <MenuItem value={ALL}>All</MenuItem>
        {lanes.map((lane) => (
          <MenuItem key={lane.lane} value={lane.lane}>
            {lane.lane}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        type="date"
        size="small"
        label="From"
        sx={fieldSx}
        slotProps={{ inputLabel: { shrink: true } }}
        value={filters.from ?? ''}
        onChange={(event) => patch({ from: event.target.value || undefined })}
      />

      <TextField
        type="date"
        size="small"
        label="To"
        sx={fieldSx}
        slotProps={{ inputLabel: { shrink: true } }}
        value={filters.to ?? ''}
        onChange={(event) => patch({ to: event.target.value || undefined })}
      />

      <TextField
        select
        size="small"
        label="Sort"
        sx={fieldSx}
        value={filters.sort}
        onChange={(event) => patch({ sort: event.target.value as TaskFilterState['sort'] })}
      >
        <MenuItem value="desc">Newest first</MenuItem>
        <MenuItem value="asc">Oldest first</MenuItem>
      </TextField>

      {isFiltered(filters) ? (
        <Button size="small" onClick={() => onChange(DEFAULT_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </Stack>
  );
}
