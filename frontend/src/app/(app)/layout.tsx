import type { ReactNode } from 'react';
import AuthAware from '@/components/AuthAware';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AuthAware>{children}</AuthAware>;
}
