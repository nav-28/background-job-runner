import * as React from 'react';

export interface MenuController<T> {
  handleClick: (event: React.MouseEvent<T>) => void;
  handleClose: () => void;
  open: boolean;
  anchorEl: T | null;
}

export function useMenu<T = HTMLElement>(): MenuController<T> {
  const [anchorEl, setAnchorEl] = React.useState<T | null>(null);
  const open = Boolean(anchorEl);

  const handleClose = React.useCallback(() => {
    setAnchorEl(null);
  }, []);
  const handleClick = React.useCallback((event: React.MouseEvent<T>) => {
    setAnchorEl(event.currentTarget);
  }, []);

  return { anchorEl, open, handleClick, handleClose };
}
