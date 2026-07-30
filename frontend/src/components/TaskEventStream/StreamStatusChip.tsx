'use client';

import Chip from '@mui/material/Chip';
import { type TaskStreamStatus, useTaskStreamStore } from './store';

/**
 * `EventSource` reconnects on its own, so an `error` means "retrying", never
 * "gave up". The copy has to say so or a transient blip reads as a dead app.
 */
const STREAM_LABEL: Record<TaskStreamStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  error: 'Reconnecting…',
};

export default function StreamStatusChip() {
  const status = useTaskStreamStore((state) => state.status);

  return (
    <Chip
      size="small"
      variant="outlined"
      color={status === 'open' ? 'success' : 'default'}
      label={STREAM_LABEL[status]}
    />
  );
}
