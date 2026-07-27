import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '@/lib/stores/ui-store';
import GlobalSnackbar from './GlobalSnackbar';

describe('<GlobalSnackbar />', () => {
  beforeEach(() => {
    act(() => useUiStore.getState().closeSnackbar());
  });

  it('renders nothing while closed', () => {
    render(<GlobalSnackbar />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the message pushed via the store', () => {
    render(<GlobalSnackbar />);
    act(() => useUiStore.getState().notify('Saved!', 'success'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
  });
});
