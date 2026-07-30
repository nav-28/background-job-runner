'use client';

import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import type { TaskStatsResponse, TaskStatus } from '@/lib/api/model';
import { statusDotColor, TASK_STATUSES } from './status';

interface StatsStripProps {
  stats?: TaskStatsResponse;
  active?: TaskStatus;
  onToggle: (status: TaskStatus) => void;
}

export default function StatsStrip({ stats, active, onToggle }: StatsStripProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 1,
        gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
      }}
    >
      {TASK_STATUSES.map((status) => {
        const selected = active === status;

        return (
          <ButtonBase
            key={status}
            onClick={() => onToggle(status)}
            aria-pressed={selected}
            aria-label={`Filter by ${status}`}
            sx={{
              display: 'block',
              textAlign: 'left',
              px: 1.5,
              py: 1,
              borderRadius: 1,
              border: 1,
              borderColor: selected ? 'primary.main' : 'divider',
              bgcolor: selected ? 'action.selected' : 'transparent',
            }}
          >
            <Typography variant="h5" component="div" sx={{ lineHeight: 1.2 }}>
              {stats ? stats[status] : '—'}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  bgcolor: statusDotColor(status),
                }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                {status}
              </Typography>
            </Box>
          </ButtonBase>
        );
      })}
    </Box>
  );
}
