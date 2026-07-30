'use client';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CopyButton from '@/components/CopyButton';
import type { CreatedApiKeyResponse } from '@/lib/api/model';

interface RevealedKeyDialogProps {
  /** Absent until a key has just been created. */
  created?: CreatedApiKeyResponse;
  open: boolean;
  onClose: () => void;
}

export default function RevealedKeyDialog({ created, open, onClose }: RevealedKeyDialogProps) {
  return (
    <Dialog open={open && created !== undefined} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Copy your API key now</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="warning">
            <AlertTitle>This is the only time the secret is shown</AlertTitle>
            The server stores a hash, not the key. Once this dialog closes there is no way to
            retrieve it — you would have to create another key.
          </Alert>

          <Box
            component="code"
            sx={{
              p: 1.5,
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'action.hover',
              fontSize: 14,
              userSelect: 'all',
              overflowWrap: 'anywhere',
            }}
          >
            {created?.key}
          </Box>

          {created ? (
            <Typography variant="caption" color="text.secondary">
              {created.name} · prefix {created.prefix}
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        {created ? <CopyButton value={created.key} label="Copy key" /> : null}
        <Button variant="contained" onClick={onClose}>
          Done, I saved it
        </Button>
      </DialogActions>
    </Dialog>
  );
}
