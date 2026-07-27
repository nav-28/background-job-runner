'use client';

import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import { useUiStore } from '@/lib/stores/ui-store';

/**
 * Renders the global toast driven by the Zustand `useUiStore`.
 * Mounted once in the providers tree; call `useUiStore().notify(...)` anywhere.
 */
export default function GlobalSnackbar() {
  const { snackbar, closeSnackbar } = useUiStore();

  return (
    <Snackbar
      open={snackbar.open}
      autoHideDuration={4000}
      onClose={closeSnackbar}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        onClose={closeSnackbar}
        severity={snackbar.severity}
        variant="filled"
        sx={{ width: '100%' }}
      >
        {snackbar.message}
      </Alert>
    </Snackbar>
  );
}
