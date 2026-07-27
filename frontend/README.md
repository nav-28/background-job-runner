# Frontend

Next.js (App Router) frontend for the template. Talks to the Fastify backend through a
**fully-typed client generated from the backend's OpenAPI spec**.

## Stack

| Concern            | Choice                                             |
| ------------------ | -------------------------------------------------- |
| Framework          | Next.js 15 (App Router, React 19)                  |
| UI                 | MUI v7 (CSS-variable light/dark theme + toggle)    |
| Server state       | TanStack Query v5                                  |
| Client state       | Zustand v5 (see `src/lib/stores/ui-store.ts`)      |
| API client         | Orval → typed TanStack Query hooks (axios mutator) |
| Lint/format        | Biome                                              |
| Tests              | Vitest + React Testing Library                     |

## Getting started

```bash
cp .env.example .env.local          # optional; defaults work for local dev
pnpm dev                            # http://localhost:3001
```

The dev server proxies `/api/*` to the backend (`BACKEND_URL`, default
`http://localhost:3000`) via `next.config.ts`, so the browser talks to the frontend
origin only — no CORS in the common case.

## Generating the API client

The client is generated into `src/lib/api/` from an OpenAPI spec.

```bash
# Regenerate from the committed snapshot (offline, no backend needed):
pnpm generate:api

# Pull a fresh spec from the running backend, then regenerate:
pnpm generate:api:live       # backend must be running on :3000
```

`generate:api:live` saves the backend spec to `openapi.json`, then Orval turns it into:

- `src/lib/api/endpoints/<tag>/<tag>.ts` — one folder per OpenAPI tag (`mode: 'tags-split'`)
  so bundlers only include the endpoints a route imports.
- `src/lib/api/model/` — request/response TypeScript types.
- `src/lib/api/api-client.ts` — the axios mutator (base URL + response unwrapping). **Hand-written, not generated.**

Config lives in `orval.config.ts`.

### Using the hooks

```tsx
import { useFindUsers, useCreateUser } from '@/lib/api/endpoints/users/users';

const { data, isLoading } = useFindUsers({ limit: 20, page: 0 });
const users = data?.data ?? [];

const createUser = useCreateUser();
createUser.mutate({ data: { email, country, postalCode, street } });
```

See `src/app/users/page.tsx` for a full CRUD example.

## Scripts

| Script                    | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `pnpm dev`                | Dev server on :3001                            |
| `pnpm build` / `pnpm start` | Production build / serve                     |
| `pnpm check`              | Biome check + `tsc --noEmit`                    |
| `pnpm test`               | Vitest                                         |
| `pnpm generate:api`       | Regenerate the client from `openapi.json`       |
| `pnpm generate:api:live`  | Pull spec from the running backend + regenerate |

## Environment

| Variable              | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | Base URL prepended to API requests. Empty = same-origin (proxied).      |
| `BACKEND_URL`         | Where the Next.js proxy forwards `/api/*` (server-side only).           |
| `OPENAPI_URL`         | Spec URL used by `generate:api:live`.                                    |
