export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function apiUrl(path: string): string {
  if (API_BASE_URL) return `${API_BASE_URL}${path}`;
  if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
  return path;
}
