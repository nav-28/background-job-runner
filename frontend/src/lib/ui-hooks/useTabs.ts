import * as React from 'react';

export interface TabsController {
  value: number;
  handleTabChange: (_: React.SyntheticEvent, newValue: number) => void;
  handleTabValueChange: (newValue: number) => void;
}

export function useTabs(startingTab?: number): TabsController {
  const [value, setValue] = React.useState(startingTab || 0);

  const handleTabChange = React.useCallback((_: React.SyntheticEvent, newValue: number) => {
    setValue(newValue);
  }, []);

  const handleTabValueChange = React.useCallback((newValue: number) => {
    setValue(newValue);
  }, []);

  return { value, handleTabChange, handleTabValueChange };
}
