'use client';

import { useTaskEvents } from '@/lib/hooks/useTaskEvents';

/**
 * Renders nothing; it exists so the stream is owned by `(app)/layout` and
 * survives navigation between pages.
 *
 * Must be mounted INSIDE `AuthAware`. In the layout body it would run during the
 * unauthenticated render, where `/api/v1/events` 401s and the browser retries
 * forever.
 */
export default function TaskEventStream() {
  useTaskEvents();
  return null;
}
