'use client';

import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import ThemeToggle from '@/components/ThemeToggle';

const navLinks = [{ href: '/', label: 'Home' }];

export default function TopBar() {
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
            sx={{ fontWeight: 700, color: 'inherit', textDecoration: 'none', mr: 2 }}
          >
            web-app-template
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexGrow: 1 }}>
            {navLinks.map((link) => (
              <Button key={link.href} component={Link} href={link.href} color="inherit">
                {link.label}
              </Button>
            ))}
          </Box>
          <ThemeToggle />
        </Toolbar>
      </Container>
    </AppBar>
  );
}
