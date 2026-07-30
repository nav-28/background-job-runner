import type { Query } from '@tanstack/react-query';

/** Every generated tasks query, matched on its URL-shaped key root. */
export function isTaskQuery(query: Query): boolean {
  const root = query.queryKey[0];
  return typeof root === 'string' && root.startsWith('/api/v1/tasks');
}
