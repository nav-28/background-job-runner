import { redirect } from 'next/navigation';

/**
 * Redirect for now.
 * TODO: Add a landing page
 *
 */
export default function RootPage() {
  redirect('/dashboard');
}
