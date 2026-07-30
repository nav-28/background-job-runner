'use client';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type SubmitEventHandler, useEffect, useState } from 'react';
import { getMeQueryKey, useLogin, useMe, useSignup } from '@/lib/api/endpoints/auth/auth';
import { apiErrorMessage } from '@/lib/api/errors';
import { MeResponseKind, type SessionResponse } from '@/lib/api/model';

type Mode = 'login' | 'signup';

const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 100;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  email?: string;
  password?: string;
  name?: string;
}

function validate(mode: Mode, email: string, password: string, name: string): FieldErrors {
  const errors: FieldErrors = {};

  if (!EMAIL_PATTERN.test(email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Passwords are at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (mode === 'signup') {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
      errors.name = `Enter a name of 1–${MAX_NAME_LENGTH} characters.`;
    }
  }

  return errors;
}

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // Someone who is already signed in should never see this form. A 401 here is
  // the expected answer, not a failure, so nothing is rendered for it.
  const { data: me } = useMe();
  const alreadySignedIn = me !== undefined;

  useEffect(() => {
    if (alreadySignedIn) router.replace('/dashboard');
  }, [alreadySignedIn, router]);

  const onSession = async (session: SessionResponse) => {
    queryClient.setQueryData(getMeQueryKey(), { user: session.user, kind: MeResponseKind.session });
    await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
    router.replace('/dashboard');
  };

  const login = useLogin({
    mutation: { meta: { suppressErrorToast: true }, onSuccess: onSession },
  });
  const signup = useSignup({
    mutation: { meta: { suppressErrorToast: true }, onSuccess: onSession },
  });

  const active = mode === 'login' ? login : signup;
  const submitError = active.error;

  const handleSubmit: SubmitEventHandler = (event) => {
    event.preventDefault();

    const errors = validate(mode, email, password, name);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (mode === 'login') {
      login.mutate({ data: { email: email.trim(), password } });
    } else {
      signup.mutate({ data: { email: email.trim(), name: name.trim(), password } });
    }
  };

  const switchMode = (next: Mode | null) => {
    if (next === null || next === mode) return;
    setMode(next);
    setFieldErrors({});
    login.reset();
    signup.reset();
  };

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', pt: { xs: 2, sm: 6 } }}>
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent component="form" onSubmit={handleSubmit} noValidate>
          <Stack spacing={2.5}>
            <Typography variant="h5" component="h1">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Typography>

            <ToggleButtonGroup
              value={mode}
              exclusive
              size="small"
              fullWidth
              onChange={(_event, next: Mode | null) => switchMode(next)}
              aria-label="Authentication mode"
            >
              <ToggleButton value="login">Sign in</ToggleButton>
              <ToggleButton value="signup">Create account</ToggleButton>
            </ToggleButtonGroup>

            {submitError ? <Alert severity="error">{apiErrorMessage(submitError)}</Alert> : null}

            {mode === 'signup' ? (
              <TextField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                error={Boolean(fieldErrors.name)}
                helperText={fieldErrors.name}
                autoComplete="name"
                fullWidth
              />
            ) : null}

            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={Boolean(fieldErrors.email)}
              helperText={fieldErrors.email}
              autoComplete="email"
              fullWidth
            />

            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={Boolean(fieldErrors.password)}
              helperText={fieldErrors.password}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              fullWidth
            />

            <Button type="submit" variant="contained" size="large" loading={active.isPending}>
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>

            <Divider />

            <Typography variant="caption" color="text.secondary">
              Demo account: <code>demo@example.com</code> / <code>password123</code>
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
