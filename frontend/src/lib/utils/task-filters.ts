import type { ListTasksParams, TaskStatus } from '@/lib/api/model';

export interface TaskFilterState {
  status?: TaskStatus;
  lane?: string;
  /** `YYYY-MM-DD`, straight off a native date input. */
  from?: string;
  to?: string;
  sort: 'asc' | 'desc';
}

export const DEFAULT_FILTERS: TaskFilterState = { sort: 'desc' };

export const INITIAL_LIMIT = 20;
export const LIMIT_STEP = 20;
/** `GET /tasks` rejects a larger `limit` outright. */
export const MAX_LIMIT = 100;

/**
 * What the mobile "Filters" badge shows. Sort counts: it changes which tasks the
 * first page holds, and counting it keeps the badge and the "Clear filters"
 * button agreeing about whether anything is set.
 */
export function activeFilterCount(filters: TaskFilterState): number {
  const set = [
    filters.status !== undefined,
    filters.lane !== undefined,
    filters.from !== undefined,
    filters.to !== undefined,
    filters.sort !== DEFAULT_FILTERS.sort,
  ];
  return set.filter(Boolean).length;
}

export function isFiltered(filters: TaskFilterState): boolean {
  return activeFilterCount(filters) > 0;
}

/** No timezone suffix, so this resolves in the zone the date input picked the day in. */
function dayBoundary(day: string, time: string): string | undefined {
  const at = new Date(`${day}T${time}`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export function toListTasksParams(filters: TaskFilterState, limit: number): ListTasksParams {
  return {
    status: filters.status,
    lane: filters.lane,
    from: filters.from ? dayBoundary(filters.from, '00:00:00.000') : undefined,
    // `to` matches `createdAt <=`, so a bare date would end the range at midnight
    // and hide everything submitted during the day the user picked.
    to: filters.to ? dayBoundary(filters.to, '23:59:59.999') : undefined,
    sort: filters.sort,
    limit,
  };
}
