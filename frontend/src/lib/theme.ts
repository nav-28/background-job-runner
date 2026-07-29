'use client';

import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: 'class',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#4f46e5' },
        secondary: { main: '#0891b2' },
        background: { default: '#f7f8fa', paper: '#ffffff' },
      },
    },
    dark: {
      palette: {
        primary: { main: '#818cf8' },
        secondary: { main: '#22d3ee' },
        background: { default: '#0b0e14', paper: '#151a23' },
      },
    },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'var(--font-roboto), Roboto, system-ui, -apple-system, Segoe UI, sans-serif',
    h1: { fontSize: '2.5rem', fontWeight: 700, letterSpacing: '-0.02em' },
    h2: { fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.01em' },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
    },
    MuiCard: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
  },
});

export default theme;
