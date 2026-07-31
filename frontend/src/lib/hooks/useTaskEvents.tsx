'use client';

import Button from '@mui/material/Button';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { closeSnackbar, enqueueSnackbar } from '@/components/GlobalSnackbar/store';
import type { SnackbarMessage, SnackbarOptions } from '@/components/GlobalSnackbar/types';
import { resetTaskStreamStatus, setTaskStreamStatus } from '@/components/TaskEventStream/store';
import { apiUrl } from '@/lib/api/config';
import { isTaskQuery } from '@/lib/api/task-queries';

interface TaskEvent {
  id: number;
  task_id: string;
  handle: string;
  lane: string;
  type: TaskEventType;
}

const CONTRACT_EVENT_TYPES = ['accepted', 'ready', 'failed', 'cancelled'] as const;

const INFORMATIONAL_EVENT_TYPES = [
  'started',
  'retry_scheduled',
  'requeued_on_restart',
  'lease_expired',
  'collected',
  'retry_requested',
] as const;

const ALL_EVENT_TYPES = [...CONTRACT_EVENT_TYPES, ...INFORMATIONAL_EVENT_TYPES] as const;

export type TaskEventType = (typeof ALL_EVENT_TYPES)[number];

const COMPLETION_VARIANTS: Partial<Record<TaskEventType, 'success' | 'error' | 'info'>> = {
  ready: 'success',
  failed: 'error',
  cancelled: 'info',
};

interface CompletionToast {
  message: SnackbarMessage;
  options: SnackbarOptions;
}

/**
 * The only place a completion toast is built.
 */
function completionToast(event: TaskEvent): CompletionToast | null {
  const variant = COMPLETION_VARIANTS[event.type];
  if (!variant) return null;

  // The timestamp keeps the key unique if a reconnect redelivers a frame already toasted.
  const key = `task-event-${event.id}-${Date.now()}`;

  return {
    message: `Task ${event.handle} ${event.type}`,
    options: {
      key,
      variant,
      action: (
        <Button
          component={Link}
          href={`/dashboard/${event.task_id}`}
          size="small"
          color="inherit"
          onClick={() => closeSnackbar(key)}
        >
          View
        </Button>
      ),
    },
  };
}

/**
 * Submitting 20 tasks produces roughly 60 events within a few seconds. One
 * refetch per event is a request storm, so invalidations are coalesced into a
 * single trailing call.
 */
const INVALIDATE_DEBOUNCE_MS = 250;

/**
 * A first connect carries no `Last-Event-ID`, and the backend reads a missing
 * cursor as 0 — "replay everything you still have". That means every historic
 * `ready`/`failed`/`cancelled` frame arrives on page load and toasts, so a fresh
 * dashboard opens with a stack of notifications about week-old seed rows. Asking
 * to start past the end suppresses only the replay; `Last-Event-ID` still wins on
 * reconnect, so nothing missed during a blip is lost.
 */
const SKIP_REPLAY_CURSOR = Number.MAX_SAFE_INTEGER;

interface UseTaskEventsOptions {
  enabled?: boolean;
}

function parseTaskEvent(raw: unknown): TaskEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as TaskEvent;
  } catch {
    return null;
  }
}

export function useTaskEvents({ enabled = true }: UseTaskEventsOptions = {}): void {
  const queryClient = useQueryClient();

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      resetTaskStreamStatus();
      return;
    }
    if (typeof EventSource === 'undefined') return;

    // Invalidate all tasks queries to refresh the data
    const invalidateTaskQueries = () => {
      void queryClient.invalidateQueries({ predicate: isTaskQuery });
    };

    const scheduleInvalidate = () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        invalidateTaskQueries();
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const source = new EventSource(apiUrl(`/api/v1/events?since=${SKIP_REPLAY_CURSOR}`), {
      withCredentials: true,
    });

    const onOpen = () => {
      setTaskStreamStatus('open');

      // Invalidate queries with a debounce to get the latest state.
      // The server might send data so the debounce helps with that
      scheduleInvalidate();
    };

    const onError = () => {
      // Browser will reconnect on its own
      setTaskStreamStatus('error');
    };

    const onTaskEvent = (event: MessageEvent<unknown>) => {
      const parsed = parseTaskEvent(event.data);
      if (!parsed) return;

      const toast = completionToast(parsed);
      if (toast) enqueueSnackbar(toast.message, toast.options);

      scheduleInvalidate();
    };

    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    // The backend sends `event: <type>` on every frame. EventSource dispatches by
    // that field, so a plain `onmessage` handler would receive NONE of these
    for (const type of ALL_EVENT_TYPES) {
      source.addEventListener(type, onTaskEvent);
    }

    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      for (const type of ALL_EVENT_TYPES) {
        source.removeEventListener(type, onTaskEvent);
      }
      source.close();

      // Without this a signed-out user keeps a stale "Live" chip: the status
      // lives in a module store that `queryClient.clear()` does not touch.
      resetTaskStreamStatus();

      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, [enabled, queryClient]);
}
