const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string): string {
  const elapsed = new Date(iso).getTime() - Date.now();
  const magnitude = Math.abs(elapsed);

  if (magnitude < MINUTE) return RELATIVE.format(Math.round(elapsed / 1000), 'second');
  if (magnitude < HOUR) return RELATIVE.format(Math.round(elapsed / MINUTE), 'minute');
  if (magnitude < DAY) return RELATIVE.format(Math.round(elapsed / HOUR), 'hour');
  return RELATIVE.format(Math.round(elapsed / DAY), 'day');
}
