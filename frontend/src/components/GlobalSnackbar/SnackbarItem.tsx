import { Alert as MuiAlert, Snackbar as MuiSnackbar } from '@mui/material';
import { forwardRef } from 'react';
import type { Snackbar } from './types';

interface SnackbarItemProps {
  snack: Snackbar;
  onClose: (key: string) => void;
}

const DEFAULT_AUTO_HIDE_DURATION = 3000; // 3 Seconds

export const SnackbarItem = forwardRef<HTMLDivElement, SnackbarItemProps>(
  ({ snack, onClose }, ref) => {
    const {
      key,
      message,
      variant = 'default',
      action,
      persist = false,
      autoHideDuration = DEFAULT_AUTO_HIDE_DURATION,
    } = snack;

    const handleClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
      if (reason === 'clickaway') {
        return;
      }
      onClose(key);
    };

    return (
      <MuiSnackbar
        ref={ref}
        open={true}
        autoHideDuration={persist ? null : autoHideDuration}
        onClose={handleClose}
        sx={{
          position: 'relative',
          pointerEvents: 'all',
          width: 'fit-content',
        }}
      >
        <MuiAlert
          onClose={handleClose}
          severity={variant === 'default' ? 'info' : variant}
          action={action}
          sx={{ mb: 1 }}
          elevation={6}
          variant="filled"
        >
          {message}
        </MuiAlert>
      </MuiSnackbar>
    );
  },
);

SnackbarItem.displayName = 'SnackbarItem';
