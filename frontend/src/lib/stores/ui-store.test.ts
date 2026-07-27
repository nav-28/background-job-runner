import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui-store';

describe('useUiStore', () => {
  beforeEach(() => {
    useUiStore.getState().closeSnackbar();
  });

  it('starts closed', () => {
    const { result } = renderHook(() => useUiStore());
    expect(result.current.snackbar.open).toBe(false);
  });

  it('notify() opens the snackbar with message and severity', () => {
    const { result } = renderHook(() => useUiStore());

    act(() => result.current.notify('Saved!', 'success'));

    expect(result.current.snackbar).toMatchObject({
      open: true,
      message: 'Saved!',
      severity: 'success',
    });
  });

  it('defaults severity to info', () => {
    const { result } = renderHook(() => useUiStore());

    act(() => result.current.notify('Heads up'));

    expect(result.current.snackbar.severity).toBe('info');
  });

  it('closeSnackbar() closes it', () => {
    const { result } = renderHook(() => useUiStore());

    act(() => result.current.notify('Bye'));
    act(() => result.current.closeSnackbar());

    expect(result.current.snackbar.open).toBe(false);
  });
});
