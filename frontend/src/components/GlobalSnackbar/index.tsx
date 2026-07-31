'use client';

import { Collapse, styled } from '@mui/material';
import { useEffect } from 'react';
import { TransitionGroup } from 'react-transition-group';
import { SnackbarItem } from './SnackbarItem';
import { DEFAULT_MAX_SNACK, useSnackbarStore } from './store';

export { SnackbarItem } from './SnackbarItem';
export { closeSnackbar, enqueueSnackbar, useSnackbarStore } from './store';
export type * from './types';
export { useSnackbar } from './useSnackbar';

interface SnackbarProviderProps {
  children: React.ReactNode;
  maxSnack?: number;
}

export function SnackbarProvider({
  children,
  maxSnack = DEFAULT_MAX_SNACK,
}: SnackbarProviderProps) {
  const setMaxSnack = useSnackbarStore((state) => state.setMaxSnack);

  useEffect(() => {
    setMaxSnack(maxSnack);
  }, [maxSnack, setMaxSnack]);

  return (
    <>
      {children}
      <SnackbarRenderer />
    </>
  );
}

const SnackbarContainer = styled('div')(({ theme }) => ({
  position: 'fixed',
  bottom: theme.spacing(2),
  left: 0,
  right: 0,
  display: 'flex',
  flexDirection: 'column-reverse',
  gap: 1,
  zIndex: theme.zIndex.snackbar,
  pointerEvents: 'none', // Allow clicks to pass through the container
}));

function SnackbarRenderer() {
  const snackbars = useSnackbarStore((state) => state.snackbars);
  const closeSnackbar = useSnackbarStore((state) => state.closeSnackbar);

  return (
    <SnackbarContainer>
      {/* Use TransitionGroup to manage enter/exit of list items  */}
      <TransitionGroup>
        {snackbars.map((snack) => (
          <Collapse key={snack.key} unmountOnExit timeout={170}>
            <SnackbarItem snack={snack} onClose={closeSnackbar} />
          </Collapse>
        ))}
      </TransitionGroup>
    </SnackbarContainer>
  );
}
