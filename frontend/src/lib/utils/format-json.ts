const UNPRINTABLE = 'Cannot display this value.';

/** `params`, `result` and event `detail` are open objects, so nesting and cycles are both possible. */
export function formatJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2) ?? UNPRINTABLE;
  } catch {
    return UNPRINTABLE;
  }
}

export function hasEntries(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}
