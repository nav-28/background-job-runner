'use client';

import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import { useState } from 'react';
import { useCreateApiKey } from '@/lib/api/endpoints/keys/keys';
import type { CreatedApiKeyResponse } from '@/lib/api/model';

const MAX_NAME_LENGTH = 100;

interface CreateApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (created: CreatedApiKeyResponse) => void;
}

export default function CreateApiKeyDialog({ open, onClose, onCreated }: CreateApiKeyDialogProps) {
  const [name, setName] = useState('');

  const create = useCreateApiKey({
    mutation: {
      onSuccess: (created) => {
        setName('');
        onCreated(created);
      },
    },
  });

  const trimmed = name.trim();

  const handleClose = () => {
    setName('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>New API key</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          helperText="A label so you can tell your keys apart."
          slotProps={{ htmlInput: { maxLength: MAX_NAME_LENGTH } }}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={trimmed.length === 0}
          loading={create.isPending}
          onClick={() => create.mutate({ data: { name: trimmed } })}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
