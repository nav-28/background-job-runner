'use client';

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import CopyButton from '@/components/CopyButton';
import { STATUS_COLOR } from '@/components/dashboard/status';
import type { TaskResponse } from '@/lib/api/model';
import { relativeTime } from '@/lib/utils/relative-time';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </Box>
  );
}

export default function TaskSummary({ task }: { task: TaskResponse }) {
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h1" sx={{ overflowWrap: 'anywhere' }}>
          {task.handle}
        </Typography>
        <Chip label={task.status} color={STATUS_COLOR[task.status]} />
        {task.collected ? <Chip size="small" variant="outlined" label="collected" /> : null}
        {task.is_seed ? (
          <Chip size="small" variant="outlined" label="demo" sx={{ opacity: 0.6 }} />
        ) : null}
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
        }}
      >
        <Fact label="Lane">{task.lane}</Fact>

        <Fact label="Task id">
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Box component="code" sx={{ fontSize: 13, userSelect: 'all' }}>
              {task.id}
            </Box>
            <CopyButton value={task.id} title="Copy task id" />
          </Stack>
        </Fact>

        <Fact label="Created">
          {new Date(task.created_at).toLocaleString()} · {relativeTime(task.created_at)}
        </Fact>

        <Fact label="Last change">
          {new Date(task.updated_at).toLocaleString()} · {relativeTime(task.updated_at)}
        </Fact>
      </Box>
    </Stack>
  );
}
