'use client';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import ErrorState from '@/components/ErrorState';
import CreateApiKeyDialog from '@/components/keys/CreateApiKeyDialog';
import RevealedKeyDialog from '@/components/keys/RevealedKeyDialog';
import { useListApiKeys, useRevokeApiKey } from '@/lib/api/endpoints/keys/keys';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api/errors';
import type { ApiKeyResponse, CreatedApiKeyResponse } from '@/lib/api/model';
import { useDialog } from '@/lib/ui-hooks/useDialog';
import { relativeTime } from '@/lib/utils/relative-time';

export default function ApiKeysPage() {
  const createDialog = useDialog();
  const revealDialog = useDialog<CreatedApiKeyResponse>();
  const revokeDialog = useDialog<ApiKeyResponse>();

  // `{count, limit, page, data}` — the house envelope. `GET /tasks` returns a bare
  // array instead; that divergence is in the API contract, so it stays.
  const keys = useListApiKeys();

  const revoke = useRevokeApiKey({
    mutation: {
      onSuccess: () => {
        revokeDialog.handleClose();
        void keys.refetch();
      },
    },
  });

  const forbidden = apiErrorStatus(keys.error) === 403;
  const rows = keys.data?.data ?? [];
  const pending = revokeDialog.data;

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h1" sx={{ flexGrow: 1 }}>
          API keys
        </Typography>
        <Button variant="contained" onClick={() => createDialog.handleOpen()} disabled={forbidden}>
          New key
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary">
        Keys authenticate the task endpoints with{' '}
        <Box component="code">Authorization: Bearer …</Box>. Key management itself is session-only,
        so a leaked key cannot mint or revoke keys.
      </Typography>

      {forbidden ? (
        <Alert severity="warning">
          <AlertTitle>Signed in with an API key</AlertTitle>
          {apiErrorMessage(keys.error)} — API keys deliberately cannot manage API keys. Sign in
          through the browser to see this page.
        </Alert>
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : null}

      {keys.isPending ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress aria-label="Loading API keys" />
        </Box>
      ) : null}

      {keys.data ? (
        rows.length === 0 ? (
          <Paper variant="outlined">
            <Typography sx={{ p: 3 }} color="text.secondary">
              No API keys yet.
            </Typography>
          </Paper>
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Prefix</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Last used</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell sx={{ overflowWrap: 'anywhere' }}>{row.name}</TableCell>
                    <TableCell>
                      <Box component="code">{row.prefix}</Box>
                    </TableCell>
                    <TableCell title={new Date(row.createdAt).toLocaleString()}>
                      {relativeTime(row.createdAt)}
                    </TableCell>
                    <TableCell
                      title={row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : undefined}
                    >
                      {row.lastUsedAt ? relativeTime(row.lastUsedAt) : 'Never'}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="error"
                        onClick={() => revokeDialog.handleOpen(row)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )
      ) : null}

      <CreateApiKeyDialog
        open={createDialog.open}
        onClose={createDialog.handleClose}
        onCreated={(created) => {
          createDialog.handleClose();
          revealDialog.handleOpen(created);
          void keys.refetch();
        }}
      />

      <RevealedKeyDialog
        open={revealDialog.open}
        created={revealDialog.data}
        onClose={revealDialog.handleClose}
      />

      <Dialog open={revokeDialog.open} onClose={revokeDialog.handleClose} fullWidth maxWidth="xs">
        <DialogTitle>Revoke {pending?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Anything using this key stops working immediately. The record itself is kept so its
            history stays auditable. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={revokeDialog.handleClose}>Keep it</Button>
          <Button
            color="error"
            variant="contained"
            loading={revoke.isPending}
            onClick={() => {
              if (pending) revoke.mutate({ id: pending.id });
            }}
          >
            Revoke
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
