import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Link from 'next/link';

const stack = [
  {
    title: 'Next.js (App Router)',
    desc: 'React Server Components, file-based routing, standalone Docker output.',
  },
  { title: 'MUI', desc: 'Component library with a CSS-variable light/dark theme and toggle.' },
  { title: 'TanStack Query', desc: 'Server-state caching, wired to the generated API hooks.' },
  { title: 'Zustand', desc: 'Lightweight client state (see the global snackbar store).' },
  { title: 'Orval', desc: 'Type-safe client generated from the backend OpenAPI spec.' },
  { title: 'Vitest + RTL', desc: 'Unit/component tests with a ready CI workflow.' },
];

export default function HomePage() {
  return (
    <Stack spacing={4}>
      <Box>
        <Typography variant="h1" gutterBottom>
          Web App Template
        </Typography>
        <Typography variant="h6" color="text.secondary" sx={{ fontWeight: 400, maxWidth: 640 }}>
          A batteries-included Next.js frontend wired to the Fastify backend&apos;s OpenAPI client.
          Build MVPs fast.
        </Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 3 }}>
          <Button component={Link} href="/users" variant="contained" size="large">
            View the Users demo
          </Button>
        </Stack>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
        }}
      >
        {stack.map((item) => (
          <Card key={item.title} variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                {item.title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {item.desc}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>
    </Stack>
  );
}
