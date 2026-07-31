import { create } from 'zustand';
import type { SnackbarMessage, SnackbarOptions, SnackbarState } from './types';

export const DEFAULT_MAX_SNACK = 3;

interface SnackbarStore extends SnackbarState {
  maxSnack: number;
  setMaxSnack: (maxSnack: number) => void;
  enqueueSnackbar: (message: SnackbarMessage, options?: SnackbarOptions) => string;
  closeSnackbar: (key: string) => void;
}

export const useSnackbarStore = create<SnackbarStore>((set) => ({
  snackbars: [],
  maxSnack: DEFAULT_MAX_SNACK,

  setMaxSnack: (maxSnack) => set({ maxSnack }),

  enqueueSnackbar: (message, options = {}) => {
    const key = options.key ?? (Date.now() + Math.random()).toString();

    set((state) => {
      const atLimit = state.snackbars.length >= state.maxSnack;
      const kept = atLimit ? state.snackbars.slice(1) : state.snackbars;
      return { snackbars: [...kept, { ...options, key, message }] };
    });

    return key;
  },

  closeSnackbar: (key) =>
    set((state) => ({ snackbars: state.snackbars.filter((snack) => snack.key !== key) })),
}));

export function enqueueSnackbar(message: SnackbarMessage, options?: SnackbarOptions): string {
  return useSnackbarStore.getState().enqueueSnackbar(message, options);
}

export function closeSnackbar(key: string): void {
  useSnackbarStore.getState().closeSnackbar(key);
}
