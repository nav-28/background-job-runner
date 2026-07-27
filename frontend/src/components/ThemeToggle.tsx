'use client';

import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import IconButton from '@mui/material/IconButton';
import { useColorScheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import { useEffect, useState } from 'react';

/**
 * Light/dark toggle backed by MUI's CSS-variable color scheme.
 * `mode` resolves to `system` initially, so we resolve against the actual
 * document preference to pick the next mode.
 */
export default function ThemeToggle() {
  const { mode, systemMode, setMode } = useColorScheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch: color scheme is only known on the client.
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <IconButton color="inherit" aria-label="Toggle theme" />;
  }

  const resolved = mode === 'system' ? systemMode : mode;
  const isDark = resolved === 'dark';

  return (
    <Tooltip title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
      <IconButton
        color="inherit"
        aria-label="Toggle theme"
        onClick={() => setMode(isDark ? 'light' : 'dark')}
      >
        {isDark ? <LightModeIcon /> : <DarkModeIcon />}
      </IconButton>
    </Tooltip>
  );
}
