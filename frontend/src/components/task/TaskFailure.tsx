'use client';

import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import JsonBlock from '@/components/task/JsonBlock';
import type { TaskError } from '@/lib/api/model';
import { hasEntries } from '@/lib/utils/format-json';

export default function TaskFailure({ error }: { error: TaskError }) {
  const { reason, retryable, ...extra } = error;

  return (
    <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      <Typography color="error.main" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
        {reason}
      </Typography>

      <Chip
        size="small"
        variant="outlined"
        color={retryable ? 'warning' : 'default'}
        label={`retryable: ${String(retryable)}`}
      />

      <Typography variant="caption" color="text.secondary">
        {retryable
          ? 'Classified as transient. This stays true after the engine has given up on it, so it does not mean another attempt is coming — use Retry if you want one.'
          : 'Classified as permanent: repeating the same work is expected to fail the same way.'}
      </Typography>

      {hasEntries(extra) ? (
        <Stack sx={{ alignSelf: 'stretch' }}>
          <JsonBlock value={extra} />
        </Stack>
      ) : null}
    </Stack>
  );
}
