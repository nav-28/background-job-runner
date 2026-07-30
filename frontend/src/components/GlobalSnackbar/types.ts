export type SnackbarMessage = string | React.ReactNode;

export interface SnackbarOptions {
  key?: string;

  /**
   * Same as variants of [MuiAlert]
   */
  variant?: 'default' | 'success' | 'error' | 'warning' | 'info';

  /**
   * If true, the snackbar will not automatically dismiss.
   * Note: If an action is provided and the snackbar is persisted,
   * then make sure to have a close button in the action
   * @default false
   */
  persist?: boolean;

  /**
   * The action to display. Renders after the message.
   */
  action?: React.ReactNode;

  /**
   * The number of milliseconds to wait before closing the snackbar
   * @default 3000
   */
  autoHideDuration?: number;
}

export interface Snackbar extends SnackbarOptions {
  key: string;
  message: SnackbarMessage;
}

export interface SnackbarState {
  snackbars: Snackbar[];
}

export interface SnackbarApi {
  enqueueSnackbar: (message: SnackbarMessage, options?: SnackbarOptions) => string;
  closeSnackbar: (key: string) => void;
}
