'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TaskViewMode = 'cards' | 'table';

interface TaskViewModeStore {
  mode: TaskViewMode;
  setMode: (mode: TaskViewMode) => void;
}

const useStore = create<TaskViewModeStore>()(
  persist(
    (set) => ({
      mode: 'cards',
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'task-view-mode',
      // Reading localStorage while rendering would make the client's first paint
      // disagree with the server's. Rehydration is deferred to an effect below.
      skipHydration: true,
    },
  ),
);

export interface TaskViewModeController {
  mode: TaskViewMode;
  setMode: (mode: TaskViewMode) => void;
  /** False until the stored preference has been read. Render the default until then. */
  ready: boolean;
}

export function useTaskViewMode(): TaskViewModeController {
  const mode = useStore((state) => state.mode);
  const setMode = useStore((state) => state.setMode);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // localStorage is synchronous, so the stored mode is applied before `ready`
    // flips and the switch happens in a single commit.
    void useStore.persist.rehydrate();
    setReady(true);
  }, []);

  return { mode, setMode, ready };
}
