import { create } from 'zustand';

export type TaskStreamStatus = 'connecting' | 'open' | 'error';

const INITIAL_STATUS: TaskStreamStatus = 'connecting';

interface TaskStreamStore {
  status: TaskStreamStatus;
  setStatus: (status: TaskStreamStatus) => void;
  reset: () => void;
}

/**
 * The stream is opened once for the whole app, but `TopBar` — which reports it —
 * lives in the root layout and can never be a child of the layout that mounts it.
 */
export const useTaskStreamStore = create<TaskStreamStore>((set) => ({
  status: INITIAL_STATUS,
  setStatus: (status) => set({ status }),
  reset: () => set({ status: INITIAL_STATUS }),
}));

export const setTaskStreamStatus = (status: TaskStreamStatus): void =>
  useTaskStreamStore.getState().setStatus(status);

export const resetTaskStreamStatus = (): void => useTaskStreamStore.getState().reset();
