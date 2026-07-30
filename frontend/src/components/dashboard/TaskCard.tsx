'use client';

import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import type { TaskResponse } from '@/lib/api/model';
import { relativeTime } from '@/lib/utils/relative-time';
import { STATUS_COLOR } from './status';

export default function TaskCard({ task }: { task: TaskResponse }) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardActionArea
        component={Link}
        href={`/dashboard/${task.id}`}
        sx={{ height: '100%', alignItems: 'stretch' }}
      >
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <Typography
              variant="subtitle1"
              component="h2"
              sx={{ fontWeight: 700, flexGrow: 1, overflowWrap: 'anywhere' }}
            >
              {task.handle}
            </Typography>

            <Stack direction={'row'} spacing={0.5}>
              {task.collected && <Chip size="small" label={'collected'} color={'secondary'} />}
              <Chip size="small" label={task.status} color={STATUS_COLOR[task.status]} />
            </Stack>
          </Stack>

          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Chip size="small" variant="outlined" label={task.lane} />
            {task.attempts > 1 ? (
              <Chip size="small" variant="outlined" label={`${task.attempts} attempts`} />
            ) : null}
            {task.is_seed ? (
              <Chip size="small" variant="outlined" label="demo" sx={{ opacity: 0.6 }} />
            ) : null}
          </Stack>

          <Typography
            variant="caption"
            color="text.secondary"
            title={new Date(task.created_at).toLocaleString()}
          >
            {relativeTime(task.created_at)}
          </Typography>

          {task.error ? (
            <Typography variant="body2" color="error.main" sx={{ overflowWrap: 'anywhere' }}>
              {task.error.reason}
            </Typography>
          ) : null}
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
