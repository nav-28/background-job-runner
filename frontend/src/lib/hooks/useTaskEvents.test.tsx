import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSnackbarStore } from '@/components/GlobalSnackbar/store';
import { getMeQueryKey } from '@/lib/api/endpoints/auth/auth';
import {
  getGetTaskHistoryQueryKey,
  getListLanesQueryKey,
  getListTasksQueryKey,
  getTaskStatsQueryKey,
} from '@/lib/api/endpoints/tasks/tasks';
import { makeQueryClient } from '@/lib/query-client';
import { useTaskEvents } from './useTaskEvents';

/**
 * jsdom ships no `EventSource`, so the hook gets a minimal fake stubbed onto
 * `globalThis`. That is the intended way to test this — the alternative is
 * threading a factory through production code purely for the tests.
 */
type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<Listener>>();
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  close() {
    this.closed = true;
  }

  /** Count of live listeners, used to prove cleanup actually detached them. */
  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  emit(type: string, data: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

const readyEvent = {
  id: 7,
  task_id: 't-1',
  handle: 'scrape-1',
  lane: 'scrape',
  type: 'ready',
  summary: 'done',
};

/** A component, not a bare hook, so it can be wrapped in `<StrictMode>`. */
function TaskEventsProbe() {
  useTaskEvents({ enabled: true });
  return null;
}

function setup() {
  const queryClient = makeQueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const view = renderHook(() => useTaskEvents({ enabled: true }), { wrapper });
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error('the hook did not construct an EventSource');

  return { ...view, source, invalidate, queryClient };
}

describe('useTaskEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useSnackbarStore.setState({ snackbars: [] });
  });

  it('coalesces a ready event into exactly one invalidation after the debounce', () => {
    const { source, invalidate } = setup();

    expect(source.init?.withCredentials).toBe(true);

    act(() => {
      source.emit('ready', readyEvent);
      // A second frame inside the window must not buy a second refetch.
      source.emit('started', { ...readyEvent, id: 8, type: 'started', detail: {} });
    });

    // Nothing yet: an immediate refetch per frame is the request storm we are
    // avoiding, so this assertion is the point of the debounce.
    expect(invalidate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(invalidate).toHaveBeenCalledTimes(1);

    // `ready` is a completion, so the user hears about it; `started` is noise.
    const { snackbars } = useSnackbarStore.getState();
    expect(snackbars).toHaveLength(1);
    expect(snackbars.at(-1)).toMatchObject({ variant: 'success' });
    expect(snackbars.at(-1)?.message).toContain('scrape-1');
  });

  it('leaves exactly one live connection under StrictMode', () => {
    // `reactStrictMode: true` in next.config.ts means development mounts,
    // unmounts and remounts every component. Counting instances rather than
    // trusting the cleanup: two live streams would double every toast, and the
    // symptom only appears in dev, which is where the demo happens.
    const queryClient = makeQueryClient();

    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TaskEventsProbe />
        </QueryClientProvider>
      </StrictMode>,
    );

    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances.filter((s) => !s.closed)).toHaveLength(1);
  });

  /**
   * The tests above spy on `invalidateQueries`, which proves it was CALLED but
   * not that its predicate matches anything. A predicate that matches nothing
   * would satisfy them while the dashboard silently stopped refreshing.
   *
   * So this one seeds the cache with the real generated query keys and asserts
   * which entries actually came back invalidated. It is the test that fails if
   * an Orval upgrade changes the key format out from under the URL-prefix match.
   */
  it('invalidates exactly the task-derived queries, against real generated keys', () => {
    const { source, queryClient } = setup();

    const taskKeys = [
      getListTasksQueryKey(),
      getTaskStatsQueryKey(),
      getGetTaskHistoryQueryKey('scrape-1'),
    ];
    // Lanes are static and `me` is a session, neither of which a task event changes.
    const untouchedKeys = [getListLanesQueryKey(), getMeQueryKey()];

    for (const key of [...taskKeys, ...untouchedKeys]) {
      queryClient.setQueryData(key, { seeded: true });
    }

    act(() => {
      source.emit('ready', readyEvent);
      vi.advanceTimersByTime(250);
    });

    for (const key of taskKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated, `${key[0]} should refetch`).toBe(true);
    }
    for (const key of untouchedKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated, `${key[0]} should not`).toBe(false);
    }
  });

  it('closes the stream and detaches listeners on unmount', () => {
    const { source, unmount } = setup();

    expect(source.closed).toBe(false);
    expect(source.listenerCount).toBeGreaterThan(0);

    unmount();

    // Without this, StrictMode's mount/unmount/remount leaves two live streams
    // and every completion toasts twice.
    expect(source.closed).toBe(true);
    expect(source.listenerCount).toBe(0);
  });
});
