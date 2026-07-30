/** `type` is an open string in the schema, so anything unmapped falls back. */
const EVENT_DOT_COLOR: Record<string, string> = {
  accepted: 'text.disabled',
  started: 'info.main',
  ready: 'success.main',
  failed: 'error.main',
  cancelled: 'warning.main',
  retry_scheduled: 'warning.main',
  retry_requested: 'warning.main',
  requeued_on_restart: 'info.main',
  lease_expired: 'warning.main',
  collected: 'success.main',
};

export function eventDotColor(type: string): string {
  return EVENT_DOT_COLOR[type] ?? 'text.disabled';
}
