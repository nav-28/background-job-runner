import type { ReactNode } from 'react';
import AuthAware from '@/components/AuthAware';
import TaskEventStream from '@/components/TaskEventStream';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthAware>
      <TaskEventStream />
      {children}
    </AuthAware>
  );
}
