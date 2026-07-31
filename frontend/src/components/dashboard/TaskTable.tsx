'use client';

import Chip from '@mui/material/Chip';
import MuiLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { TaskResponse } from '@/lib/api/model';
import { relativeTime } from '@/lib/utils/relative-time';
import { STATUS_COLOR } from './status';

/** Addressed by uuid: handles are recycled and resolve to whoever holds the number now. */
function taskHref(task: TaskResponse) {
  return `/dashboard/${task.id}`;
}

export default function TaskTable({ tasks }: { tasks: TaskResponse[] }) {
  const router = useRouter();

  return (
    <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Handle</TableCell>
            <TableCell>Lane</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Attempts</TableCell>
            <TableCell>Created</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {tasks.map((task) => (
            <TableRow
              key={task.id}
              hover
              onClick={() => router.push(taskHref(task))}
              sx={{ cursor: 'pointer' }}
            >
              <TableCell>
                {/* A row click is not keyboard-reachable, so the handle is a real link. */}
                <MuiLink
                  component={Link}
                  href={taskHref(task)}
                  onClick={(event) => event.stopPropagation()}
                  underline="hover"
                  color="inherit"
                  sx={{ fontWeight: 600 }}
                >
                  {task.handle}
                </MuiLink>
                {task.is_seed ? (
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    demo
                  </Typography>
                ) : null}
              </TableCell>

              <TableCell>{task.lane}</TableCell>

              <TableCell>
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  <Chip size="small" label={task.status} color={STATUS_COLOR[task.status]} />
                  {task.collected ? (
                    <Chip size="small" label="collected" color="secondary" />
                  ) : null}
                </Stack>
                {task.error ? (
                  <Typography
                    variant="caption"
                    color="error.main"
                    sx={{ display: 'block', mt: 0.5, maxWidth: 360, overflowWrap: 'anywhere' }}
                  >
                    {task.error.reason}
                  </Typography>
                ) : null}
              </TableCell>

              <TableCell align="right">{task.attempts}</TableCell>

              <TableCell>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  title={new Date(task.created_at).toLocaleString()}
                  sx={{ whiteSpace: 'nowrap' }}
                >
                  {relativeTime(task.created_at)}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
