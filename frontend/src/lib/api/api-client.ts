import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';

/**
 * Axios instance + mutator used by the Orval-generated client (see orval.config.ts).
 *
 * `baseURL` is empty by default so requests hit the same origin and are proxied
 * to the backend by Next.js (see `rewrites` in next.config.ts) — no CORS. Set
 * NEXT_PUBLIC_API_URL to call an absolute backend URL directly instead.
 *
 * The mutator returns `response.data` so generated hooks resolve to the response
 * body directly (e.g. `useFindUsers().data` is the paginated payload).
 */
export const axiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? '',
  headers: { 'Content-Type': 'application/json' },
});

export const customInstance = async <T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> => {
  const { data } = await axiosInstance({ ...config, ...options });
  return data;
};

// Types Orval references for error/body generics.
export type ErrorType<Error> = AxiosError<Error>;
export type BodyType<BodyData> = BodyData;
