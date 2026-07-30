'use client';

import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

interface SectionProps {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}

export default function Section({ title, action, children }: SectionProps) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}
      >
        <Typography
          variant="subtitle2"
          component="h2"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}
        >
          {title}
        </Typography>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}
