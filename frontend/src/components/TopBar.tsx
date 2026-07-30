'use client';

import MenuIcon from '@mui/icons-material/Menu';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import StreamStatusChip from '@/components/TaskEventStream/StreamStatusChip';
import ThemeToggle from '@/components/ThemeToggle';
import { useLogout, useMe } from '@/lib/api/endpoints/auth/auth';
import { useDialog } from '@/lib/ui-hooks/useDialog';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Tasks' },
  { href: '/keys', label: 'API keys' },
];

export default function TopBar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const navDrawer = useDialog();

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
          {/* Signed out there is nothing to put in the drawer, so no hamburger. */}
          {me ? (
            <IconButton
              edge="start"
              color="inherit"
              aria-label="Open navigation"
              onClick={() => navDrawer.handleOpen()}
              sx={{ display: { xs: 'inline-flex', sm: 'none' } }}
            >
              <MenuIcon />
            </IconButton>
          ) : null}

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
            <Stack
              direction="row"
              spacing={0.5}
              component="nav"
              sx={{ display: { xs: 'none', sm: 'flex' } }}
            >
              {NAV_LINKS.map((link) => (
                <Button key={link.href} component={Link} href={link.href} color="inherit">
                  {link.label}
                </Button>
              ))}
            </Stack>
          ) : null}

          <Box sx={{ flexGrow: 1 }} />

          {/* One stream for the whole app, so its state belongs here, not on a page. */}
          {me ? <StreamStatusChip /> : null}

          {me ? (
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', display: { xs: 'none', sm: 'flex' } }}
            >
              <Typography variant="body2" color="text.secondary">
                {me.user.email}
              </Typography>
              <Button color="inherit" onClick={() => logout.mutate()} loading={logout.isPending}>
                Sign out
              </Button>
            </Stack>
          ) : null}

          <ThemeToggle />
        </Toolbar>
      </Container>

      {me ? (
        <Drawer
          open={navDrawer.open}
          onClose={navDrawer.handleClose}
          sx={{ display: { xs: 'block', sm: 'none' } }}
        >
          <Box sx={{ width: 240 }} onClick={navDrawer.handleClose}>
            <List component="nav">
              {NAV_LINKS.map((link) => (
                <ListItemButton key={link.href} component={Link} href={link.href}>
                  <ListItemText primary={link.label} />
                </ListItemButton>
              ))}
            </List>
            <Divider />
            <Stack spacing={1} sx={{ p: 2, alignItems: 'flex-start' }}>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {me.user.email}
              </Typography>
              <Button color="inherit" onClick={() => logout.mutate()} loading={logout.isPending}>
                Sign out
              </Button>
            </Stack>
          </Box>
        </Drawer>
      ) : null}
    </AppBar>
  );
}
