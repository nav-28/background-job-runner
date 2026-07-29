import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/**
 * Placeholder landing page. Phase 1 replaces this entirely with the real entry
 * point, so it stays deliberately plain — and it links nowhere, because none of
 * the app routes exist yet.
 */
export default function HomePage() {
  return (
    <Stack spacing={2}>
      <Typography variant="h1">Job Runner</Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 640 }}>
        Submit work to a queue, watch it move through the orchestration engine, and collect the
        result when it finishes.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        The UI is still being built.
      </Typography>
    </Stack>
  );
}
