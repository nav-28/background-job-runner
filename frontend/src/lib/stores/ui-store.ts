import { create } from 'zustand';

export type SnackbarSeverity = 'success' | 'info' | 'warning' | 'error';

interface SnackbarState {
  open: boolean;
  message: string;
  severity: SnackbarSeverity;
}

interface UiStore {
  snackbar: SnackbarState;
  /** Show a global toast. Used across the app to surface success/error feedback. */
  notify: (message: string, severity?: SnackbarSeverity) => void;
  closeSnackbar: () => void;
}

const initialSnackbar: SnackbarState = {
  open: false,
  message: '',
  severity: 'info',
};

/**
 * Small example Zustand store for cross-cutting UI state (global snackbar).
 * Add more slices here (e.g. a nav drawer) as the app grows, or split into
 * multiple stores under `src/lib/stores/`.
 */
export const useUiStore = create<UiStore>((set) => ({
  snackbar: initialSnackbar,
  notify: (message, severity = 'info') => set({ snackbar: { open: true, message, severity } }),
  closeSnackbar: () => set((state) => ({ snackbar: { ...state.snackbar, open: false } })),
}));
