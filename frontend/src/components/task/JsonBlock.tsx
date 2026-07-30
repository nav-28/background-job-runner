'use client';

import Box from '@mui/material/Box';
import { formatJson } from '@/lib/utils/format-json';

export default function JsonBlock({ value }: { value: unknown }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        borderRadius: 1,
        bgcolor: 'action.hover',
        fontSize: 13,
        lineHeight: 1.6,
        maxHeight: 420,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      {formatJson(value)}
    </Box>
  );
}
