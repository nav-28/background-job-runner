'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { eventDotColor } from '@/components/task/event-colors';
import JsonBlock from '@/components/task/JsonBlock';
import type { TaskEventResponse } from '@/lib/api/model';
import { hasEntries } from '@/lib/utils/format-json';
import { relativeTime } from '@/lib/utils/relative-time';

export default function TaskHistoryTimeline({ events }: { events: TaskEventResponse[] }) {
  if (events.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No events recorded yet.
      </Typography>
    );
  }

  return (
    <Box>
      {events.map((event, index) => {
        const last = index === events.length - 1;

        return (
          <Box
            key={event.id}
            sx={{ display: 'grid', gridTemplateColumns: '12px 1fr', columnGap: 1.5 }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <Box
                sx={{
                  mt: '6px',
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  bgcolor: eventDotColor(event.type),
                  flexShrink: 0,
                }}
              />
              {last ? null : (
                <Box sx={{ flexGrow: 1, width: '2px', bgcolor: 'divider', my: 0.5 }} />
              )}
            </Box>

            <Box sx={{ pb: last ? 0 : 2, minWidth: 0 }}>
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
              >
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {event.type}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {new Date(event.at).toLocaleString()} · {relativeTime(event.at)}
                </Typography>
              </Stack>

              {hasEntries(event.detail) ? (
                <Box sx={{ mt: 0.75 }}>
                  <JsonBlock value={event.detail} />
                </Box>
              ) : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
