'use client';

import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';
import { useLogout, useMe } from '@/lib/api/endpoints/auth/auth';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Tasks' },
  { href: '/keys', label: 'API keys' },
];

export default function TopBar() {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  /**
   * `enabled: false` on purpose since the bar renders on the public `/login`
   */
  const { data: me } = useMe({ query: { enabled: false } });

  const logout = useLogout({
    mutation: {
      // Whether or not the POST succeeded, the local session is over. Clearing
      // the cache is what actually signs the user out client-side: the cookie is
      // HttpOnly and unreachable from JS, so the cached user is the only thing
      // we can drop.
      onSettled: () => {
        queryClient.clear();
        router.replace('/login');
      },
    },
  });

  return (
    <AppBar
      position="sticky"
      color="default"
      elevation={0}
      sx={{ borderBottom: 1, borderColor: 'divider' }}
    >
      <Container maxWidth="lg">
        <Toolbar disableGutters sx={{ gap: 1 }}>
          <Typography
            component={Link}
            href="/"
            variant="h6"
            sx={{
              fontWeight: 700,
              color: 'inherit',
              textDecoration: 'none',
              mr: 2,
            }}
          >
            Job Runner
          </Typography>

          {me ? (
            <Stack direction="row" spacing={0.5} component="nav">
              {NAV_LINKS.map((link) => (
                <Button key={link.href} component={Link} href={link.href} color="inherit">
                  {link.label}
                </Button>
              ))}
            </Stack>
          ) : null}

          <Box sx={{ flexGrow: 1 }} />

          {me ? (
            <>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ display: { xs: 'none', sm: 'block' } }}
              >
                {me.user.email}
              </Typography>
              <Button color="inherit" onClick={() => logout.mutate()} loading={logout.isPending}>
                Sign out
              </Button>
            </>
          ) : null}

          <ThemeToggle />
        </Toolbar>
      </Container>
    </AppBar>
  );
}
