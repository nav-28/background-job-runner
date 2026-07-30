import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Link from 'next/link';

const CAPABILITIES = [
  'Submit a task to a lane and get a short handle back straight away.',
  'Watch state changes arrive live — queued, running, ready, failed, cancelled.',
  'Collect results, retry a failure or cancel work still in the queue.',
  'Filter by status, lane and date, with a count for every state.',
  'Issue API keys and drive the same endpoints from your own code.',
];

export default function LandingPage() {
  return (
    <Stack spacing={4} sx={{ maxWidth: 720, py: { xs: 2, sm: 6 } }}>
      <Stack spacing={2}>
        <Typography variant="h1" component="h1">
          Job Runner
        </Typography>
        <Typography variant="h6" component="p" color="text.secondary" sx={{ fontWeight: 400 }}>
          A background job runner: submit work, watch it run, collect the results.
        </Typography>
      </Stack>

      <Stack component="ul" spacing={1} sx={{ m: 0, pl: 3 }}>
        {CAPABILITIES.map((capability) => (
          <Typography key={capability} component="li" variant="body1">
            {capability}
          </Typography>
        ))}
      </Stack>

      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button component={Link} href="/login" variant="contained" size="large">
          Sign in
        </Button>
        <Button component={Link} href="/dashboard" size="large">
          Open the dashboard
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="overline" color="text.secondary">
          Demo account
        </Typography>
        <Box>
          <Typography variant="body2" color="text.secondary">
            <code>demo@example.com</code> / <code>password123</code>
          </Typography>
        </Box>
      </Paper>
    </Stack>
  );
}
