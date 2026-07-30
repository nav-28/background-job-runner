'use client';

import { closeSnackbar, enqueueSnackbar } from './store';
import type { SnackbarApi } from './types';

const api: SnackbarApi = { enqueueSnackbar, closeSnackbar };

export const useSnackbar = (): SnackbarApi => api;
