import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { API_BASE_URL } from '@/lib/api/config';

/**
 * Axios instance + mutator used by the Orval-generated client (see orval.config.ts).
 *
 * The browser calls the backend **directly** — there is no Next.js rewrite proxy
 * any more. `baseURL` therefore comes from `API_BASE_URL` (see config.ts), which
 * reads NEXT_PUBLIC_API_URL and is inlined at build time. The backend must allow
 * this frontend's origin via CORS_ORIGIN.
 *
 * The mutator returns `response.data` so generated hooks resolve to the response
 * body directly (e.g. `useListTasks().data` is the task array).
 *
 * ⚠ DO NOT USE the generated `useStreamEvents` / `streamEvents` for
 * `GET /api/v1/events`. That endpoint is a Server-Sent Events stream: this
 * mutator buffers the whole response and the stream never ends, so the call
 * hangs forever and the query never settles. `src/lib/hooks/useTaskEvents.ts`
 * hand-rolls a native `EventSource` hook for it instead. Nothing should import
 * those two symbols.
 */
export const axiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  // The session is an HttpOnly cookie set by the backend, which is now a
  // different origin. Without this the browser sends no cookies cross-origin and
  // every authenticated request 401s. Requires the backend to reply with
  // `Access-Control-Allow-Credentials: true` and an explicit origin — it does.
  withCredentials: true,
});

/** True for the auth endpoints that own their own 401s (login/signup/me/logout). */
function isAuthRequest(url: string | undefined): boolean {
  return typeof url === 'string' && url.includes('/auth/');
}

/**
 * Global 401 handling: a session that expires mid-use should land the caller on
 * /login rather than leave a page full of empty 401s.
 *
 * Deliberately does NOT redirect when:
 *  - the request is an `/auth/` call — `GET /auth/me` returning 401 is how the
 *    app learns nobody is signed in, and a failed login must show its own
 *    message rather than bounce;
 *  - we are already on /login, which would loop the navigation;
 *  - there is no `window` (SSR).
 *
 * `window.location.assign` rather than a router push: this interceptor lives
 * outside React and has no router. The full-page navigation is also what clears
 * the session client-side — the cookie itself is HttpOnly and unreachable from
 * JS, so the thing we can drop is the cached user in the QueryClient, and a hard
 * navigation discards it wholesale. The error is always re-rejected so the
 * calling hook still sees the failure.
 */
axiosInstance.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (
      error.response?.status === 401 &&
      typeof window !== 'undefined' &&
      !isAuthRequest(error.config?.url) &&
      window.location.pathname !== '/login'
    ) {
      window.location.assign('/login');
    }
    return Promise.reject(error);
  },
);

export async function customInstance<T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> {
  const { data } = await axiosInstance({ ...config, ...options });
  return data;
}

// Types Orval references for error/body generics.
export type ErrorType<Error> = AxiosError<Error>;
export type BodyType<BodyData> = BodyData;
