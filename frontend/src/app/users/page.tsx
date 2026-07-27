'use client';

import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import {
  getFindUsersQueryKey,
  useCreateUser,
  useDeleteUser,
  useFindUsers,
} from '@/lib/api/endpoints/users/users';
import type { CreateUserBody } from '@/lib/api/model';
import { useUiStore } from '@/lib/stores/ui-store';

const emptyForm: CreateUserBody = { email: '', country: '', postalCode: '', street: '' };

export default function UsersPage() {
  const queryClient = useQueryClient();
  const notify = useUiStore((s) => s.notify);
  const [form, setForm] = useState<CreateUserBody>(emptyForm);

  const usersQuery = useFindUsers({ limit: 20, page: 0 });

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: getFindUsersQueryKey() });

  const createUser = useCreateUser({
    mutation: {
      onSuccess: async () => {
        setForm(emptyForm);
        notify('User created', 'success');
        await invalidateUsers();
      },
      onError: (error) => notify(error.message ?? 'Failed to create user', 'error'),
    },
  });

  const deleteUser = useDeleteUser({
    mutation: {
      onSuccess: async () => {
        notify('User deleted', 'info');
        await invalidateUsers();
      },
      onError: (error) => notify(error.message ?? 'Failed to delete user', 'error'),
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    createUser.mutate({ data: form });
  };

  const setField = (key: keyof CreateUserBody) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const users = usersQuery.data?.data ?? [];

  return (
    <Stack spacing={4}>
      <Box>
        <Typography variant="h1" gutterBottom>
          Users
        </Typography>
        <Typography color="text.secondary">
          A full CRUD example wired through the generated OpenAPI client and TanStack Query.
        </Typography>
      </Box>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Create a user
          </Typography>
          <Box component="form" onSubmit={handleSubmit}>
            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              }}
            >
              <TextField
                label="Email"
                type="email"
                required
                value={form.email}
                onChange={setField('email')}
              />
              <TextField
                label="Country"
                required
                value={form.country}
                onChange={setField('country')}
              />
              <TextField
                label="Postal code"
                required
                value={form.postalCode}
                onChange={setField('postalCode')}
              />
              <TextField
                label="Street"
                required
                value={form.street}
                onChange={setField('street')}
              />
            </Box>
            <Button type="submit" variant="contained" sx={{ mt: 2 }} loading={createUser.isPending}>
              Create user
            </Button>
          </Box>
        </CardContent>
      </Card>

      <Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">
            All users{usersQuery.data ? ` (${usersQuery.data.count})` : ''}
          </Typography>
          {usersQuery.isFetching && <CircularProgress size={18} />}
        </Stack>

        {usersQuery.isError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Failed to load users: {usersQuery.error.message}. Is the backend running?
          </Alert>
        )}

        <TableContainer component={Card} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Email</TableCell>
                <TableCell>Country</TableCell>
                <TableCell>Postal code</TableCell>
                <TableCell>Street</TableCell>
                <TableCell>Role</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {usersQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                    <CircularProgress size={24} />
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No users yet — create one above.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.id} hover>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>{user.country}</TableCell>
                    <TableCell>{user.postalCode}</TableCell>
                    <TableCell>{user.street}</TableCell>
                    <TableCell>{user.role}</TableCell>
                    <TableCell align="right">
                      <IconButton
                        aria-label={`Delete ${user.email}`}
                        color="error"
                        disabled={deleteUser.isPending}
                        onClick={() => deleteUser.mutate({ id: user.id })}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Stack>
  );
}
