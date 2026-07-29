# Backend

Fastify API for **web-app-template**. TypeScript, ESM-only, Node ≥ 24 (native TS execution, no build
step). Postgres via [postgres.js](https://github.com/porsager/postgres), migrations via
[DBMate](https://github.com/amacneil/dbmate).

Deliberately small: a request goes **route → service → repository**, and every one of those is a
plain function you can find with go-to-definition. No DI container, no command/query buses, no
generated wiring.

> Part of the [`web-app-template`](../README.md) monorepo. Conventions and the guide for adding a
> module live in [`AGENTS.md`](AGENTS.md).

## Stack

| Concern     | Choice                                          |
| ----------- | ----------------------------------------------- |
| Framework   | Fastify 5                                       |
| Language    | TypeScript (strict, ESM, native TS on Node 24)  |
| Data        | Postgres + postgres.js, DBMate migrations       |
| Validation  | TypeBox schemas on every route                  |
| API         | REST (`/api/v1`), OpenAPI at `/api-docs`        |
| Lint/format | Biome                                           |
| Tests       | `node:test` (unit + integration via `inject()`) |

## Getting started

```bash
pnpm install            # from the repo root
pnpm create:env         # copy .env.example → .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev                # http://localhost:3000  (Swagger UI at /api-docs)
```

## Layout

```
src/
├── index.ts            bootstrap — build the app, listen, shut down cleanly
├── app.ts              buildApp(): plugins + route registration. Read this first.
├── config/env.ts       env parsing/validation (env-schema + TypeBox)
├── db.ts               postgres.js singleton, joinConditions, withTransaction
├── engine/             the orchestration engine — a standalone library, not a module.
│                       See docs/OrchestrationEngine.md. Never imports Fastify.
├── workers/            concrete workers (the mock worker). Outside the engine on purpose.
├── lib/
│   ├── errors.ts       AppError subclasses → HTTP status codes
│   ├── http.ts         shared TypeBox: id/error/pagination schemas + helpers
│   └── password.ts     scrypt password hashing (node:crypto, no native deps)
├── plugins/            error handler, request context, auth, engine, swagger
└── modules/
    ├── apikey/         one feature = one folder
    │   ├── apikey.routes.ts       HTTP: schemas, status codes. No logic.
    │   ├── apikey.service.ts      business logic. No HTTP, no SQL.
    │   ├── apikey.repository.ts   SQL. No HTTP, no logic.
    │   ├── apikey.schema.ts       TypeBox request/response schemas
    │   └── apikey.types.ts        domain types
    ├── auth/           signup / login / logout / me
    ├── task/           the engine's HTTP surface — routes + schema only (see below)
    └── user/           data layer behind auth — no routes of its own
tests/
├── helpers.ts                    buildTestApp() + truncation
├── auth.test.ts                  integration tests through app.inject()
├── apikey.test.ts
├── task.test.ts                  the brief's nine success criteria, over HTTP
├── events.test.ts                SSE, over a real socket on an ephemeral port
├── durability-restart.test.ts    criterion 9 — spawn, SIGKILL, restart, verify
└── engine/                       the engine's own suite, no HTTP involved
```

`src/modules/apikey/` is the reference example — copy it when adding a feature.

**`src/modules/task/` deliberately has no service and no repository.** The engine is the service
layer and owns every statement that touches `tasks`, so a handler reads the caller, calls one
engine method and shapes the answer. Adding a `task.service.ts` that forwards to `app.engine`
would be a layer with nothing in it.

## Auth

Two credential kinds resolve to the same `userId`, both handled by one `onRequest` hook in
`src/plugins/auth.ts`:

- **humans** — a 4-hour JWT in an HttpOnly, SameSite=Lax, host-only cookie, issued by
  `/auth/signup` and `/auth/login` (also returned in the body for curl and tests)
- **machines** — a long-lived revocable API key, `Authorization: Bearer jrk_…`

Auth is **opt-in per route**; a route that declares nothing costs nothing.

```ts
app.get('/thing', { config: { auth: true } }, handler)                     // either kind
app.post('/keys', { config: { auth: { session: true, apiKey: false } } })  // humans only
```

Handlers read the caller with `const { userId } = requireAuth(req)`. Missing/invalid/expired/revoked
credentials are **401**; a valid credential of a kind the route does not accept is **403**.

`JWT_SECRET` is required with no default — the app refuses to boot without it.

## Key endpoints

| Path                  | Auth         | Description                             |
| --------------------- | ------------ | --------------------------------------- |
| `/api/v1/auth/signup` | public       | Create an account, start a session      |
| `/api/v1/auth/login`  | public       | Exchange email + password for a session |
| `/api/v1/auth/logout` | public       | Clear the session cookie                |
| `/api/v1/auth/me`     | session/key  | The caller and how they authenticated   |
| `/api/v1/keys`        | session only | List / create API keys                  |
| `/api/v1/keys/{id}`   | session only | Revoke an API key                       |
| `/api-docs`           | public       | Swagger UI                              |
| `/api-docs/json`      | public       | OpenAPI JSON (client gen)               |
| `/health`             | public       | Health check                            |

## The task API

The engine's HTTP surface. Every task route accepts **either** credential kind — the dashboard
authenticates by session cookie, scripts and CI by `Authorization: Bearer jrk_…` — because both are
first-class clients of the same API. `/lanes` is the one exception and is public.

| Method | Path                              | Auth        | Description                                            |
| ------ | --------------------------------- | ----------- | ------------------------------------------------------ |
| POST   | `/api/v1/tasks`                   | session/key | Enqueue a job; returns the task with its handle at once |
| GET    | `/api/v1/tasks`                   | session/key | List tasks (see filters below). **Bare array.**        |
| GET    | `/api/v1/tasks/stats`             | session/key | Counts per status; every status present, zeroed        |
| GET    | `/api/v1/tasks/{handle}`          | session/key | One task by handle                                     |
| GET    | `/api/v1/tasks/{handle}/result`   | session/key | Collect the result; flips `collected` and frees the number |
| GET    | `/api/v1/tasks/{handle}/history`  | session/key | Every transition, oldest first, with timestamps        |
| POST   | `/api/v1/tasks/{handle}/cancel`   | session/key | Cancel queued/running (or dismiss a failed) task       |
| POST   | `/api/v1/tasks/{handle}/retry`    | session/key | Requeue a failed task with a fresh attempt budget      |
| GET    | `/api/v1/tasks/id/{uuid}`         | session/key | One task by immutable id — works for retired tasks     |
| GET    | `/api/v1/lanes`                   | **public**  | Lane names and parameter descriptors                   |
| GET    | `/api/v1/events`                  | session/key | SSE stream of lifecycle events                         |

`GET /tasks` filters: `?status=` `?lane=` `?from=` `?to=` (ISO 8601, on `created_at`) `?sort=asc|desc`
`?limit=` (≤100) `?offset=`.

### The task object

Field names and shapes are fixed by the API contract. Three fields are **additive**: `id`,
`attempts` and `is_seed` — a client written to the contract keeps working, and none of the fixed
fields is renamed or omitted.

```jsonc
{
  "id": "2cdc8ab1-…",          // additive: handles are recycled, this never is
  "handle": "scrape-1",
  "lane": "scrape",
  "params": { "duration_ms": 10000 },
  "status": "queued",          // queued | running | ready | failed | cancelled
  "result": null,              // populated only when status is `ready`
  "error": null,               // populated only when status is `failed`
  "attempts": 0,               // additive: lifetime execution count, never reset
  "collected": false,
  "is_seed": false,            // additive: fixture rows never execute
  "created_at": "2026-05-30T18:00:00.000Z",
  "updated_at": "2026-05-30T18:00:00.000Z"
}
```

`error` is `{ "reason": string, "retryable": boolean }`. `retryable` describes the *nature* of the
error, not whether the engine will auto-retry it — a transient failure that exhausts its budget
stays `retryable: true` with a reason that names the exhaustion, so an operator can tell "worth
another go" from "this will never work".

> `result` and `error` are **derived from `status`** rather than copied from the row. The engine
> keeps the last attempt's error on a task it has requeued for a retry, which is honest internally
> but would make a client written to the contract render a queued task as failed. The interim
> reason is not lost — it is on the `retry_scheduled` event in `GET /tasks/{handle}/history`.

### Three deliberate divergences

These are decisions, not oversights, and each is a trade the contract wins:

1. **`GET /tasks` returns a bare array**, not this API's `{count, limit, page, data}` envelope that
   `GET /keys` uses. The contract fixes the shape, and a reviewer's script doing
   `res.json()[0].handle` must not break on a local convention. The inconsistency is intentional:
   an endpoint whose shape is specified externally follows the specification, and one whose shape
   is ours follows the house style.
2. **`/tasks/{handle}/result` returns the whole task object** with `result` populated and
   `collected: true`, rather than the bare result value. Collecting is a state transition, and the
   caller almost always wants the new state (`collected`, `updated_at`) alongside the payload —
   returning the task means one response instead of a fetch-then-refetch. Collecting anything that
   is not `ready`, or collecting twice, is a `409`.
3. **`GET /lanes` is public.** It exposes lane names and parameter descriptors only — no user data
   of any kind — and a public one lets the submit form render before the user has logged in.

### Events

`GET /api/v1/events` is a server-sent event stream, framed by
[`@fastify/sse`](https://github.com/fastify/sse). Four event types are the contract:

```jsonc
{ "type": "accepted",  "handle": "scrape-1", "lane": "scrape", "summary": "…" }
{ "type": "ready",     "handle": "scrape-1", "lane": "scrape", "summary": "…" }
{ "type": "failed",    "handle": "scrape-1", "lane": "scrape", "reason": "…", "retryable": true }
{ "type": "cancelled", "handle": "scrape-1", "lane": "scrape" }
```

Each also carries an additive `id` (the `task_events` id, and the SSE frame's `id:`) and `task_id`.
`user_id` is stripped: it is bus routing metadata and the client already knows who it is.
`started`, `retry_scheduled`, `requeued_on_restart`, `lease_expired`, `collected` and
`retry_requested` also stream, carrying a raw `detail`; clients may ignore them.

**Reconnection is gap-free.** Every frame carries `id:`, so a browser's `EventSource` sends
`Last-Event-ID` automatically on reconnect and receives exactly what it missed; a curl client uses
`?since=<id>` for the same effect. The handler subscribes *before* it replays and buffers what
arrives in between, so an event that fires during the handover is neither lost nor duplicated.

```bash
curl -N -H "Authorization: Bearer jrk_…" http://localhost:3000/api/v1/events
curl -N -H "Authorization: Bearer jrk_…" 'http://localhost:3000/api/v1/events?since=41'
```

### The engine

`src/engine/` is a standalone library — it never imports Fastify, and it knows no lane names.
`src/plugins/engine.ts` is where the two meet: it reads `ENGINE_*` from the environment, registers
the workers, decorates `app.engine`, starts the claim loop on `onReady` and drains it on shutdown.
**Adding a lane is one entry in the `workers` array in that file.** The design, the trade-offs and
the limitations are written up in [`docs/OrchestrationEngine.md`](docs/OrchestrationEngine.md).

Every knob is an environment variable, all documented in `.env.example`:

| Variable                  | Default  | Controls                                            |
| ------------------------- | -------- | --------------------------------------------------- |
| `ENGINE_CONCURRENCY`      | `4`      | Jobs in flight in this process at once              |
| `ENGINE_POLL_INTERVAL_MS` | `200`    | Claim-loop interval when idle                       |
| `ENGINE_LEASE_MS`         | `30000`  | How long a claimed row stays owned                  |
| `ENGINE_HEARTBEAT_MS`     | `10000`  | Lease renewal cadence; also the lease reaper's      |
| `ENGINE_MAX_ATTEMPTS`     | `3`      | Attempts before a task is declared failed           |
| `ENGINE_BACKOFF_BASE_MS`  | `500`    | First retry delay; doubles per attempt              |
| `ENGINE_BACKOFF_MAX_MS`   | `30000`  | Backoff ceiling, before up to 20% jitter            |
| `ENGINE_JOB_TIMEOUT_MS`   | `300000` | Liveness backstop for a worker that hangs           |
| `ENGINE_BOOT_SWEEP`       | `true`   | Requeue orphaned `running` rows at boot             |

> ⚠️ `ENGINE_BOOT_SWEEP` **must be `false` if you run more than one backend process** against one
> database: a second process booting would otherwise requeue its peers' live, heartbeated work.
> With it off, crashed work is recovered by lease expiry instead, one `ENGINE_LEASE_MS` later.

### Seed data

`pnpm db:seed` creates two accounts and a week of demo tasks:

| Account                | Password      | API key                                     | Contents                      |
| ---------------------- | ------------- | ------------------------------------------- | ----------------------------- |
| `demo@example.com`     | `password123` | `jrk_demo_key_do_not_use_in_production_0001` | 10 tasks, every status        |
| `reviewer@example.com` | `password123` | `jrk_reviewer_key_do_not_use_in_prod_0001`   | **empty** — a clean slate     |

The demo tasks cover every status, spread over a week so the date filter does something visible,
with results, errors and matching `task_events` rows so the detail view's history is never empty.
Only the SHA-256 of each key is stored, exactly as for a key minted through `POST /keys`; the
plaintext is in a SQL comment because these are throwaway local credentials.

Every seeded task carries `is_seed: true`, and the claim query, the boot sweep and the lease
reaper all filter on `AND NOT "isSeed"` — so the seeded `running` and `queued` rows look like live
work on the dashboard and can never actually execute.

> `pnpm test:integration` truncates the tables, seeds included. Re-seed with `pnpm db:seed:reset`
> (DBMate records seeds in `schema_migrations`, so a plain `pnpm db:seed` would consider them
> already applied).

## Scripts

| Script                     | Description                                    |
| -------------------------- | ---------------------------------------------- |
| `pnpm dev` / `pnpm start`  | Run in watch mode                              |
| `pnpm check`               | Biome check + `tsc --noEmit`                   |
| `pnpm test`                | Unit tests — fast, no database                 |
| `pnpm test:integration`    | Integration tests — **needs Postgres running** |
| `pnpm test:coverage`       | Both suites under c8                           |
| `pnpm db:migrate`          | Run DB migrations                              |
| `pnpm db:create-migration` | Scaffold a new migration                       |
| `pnpm db:seed`             | Run seeds                                      |
| `pnpm db:seed:reset`       | Roll the seeds back and re-apply them          |

## Testing

`pnpm test` runs `*.spec.ts` next to the source — pure functions, no I/O, safe in a pre-commit hook.

`pnpm test:integration` runs `tests/**/*.test.ts` against a real database. Most of it drives the
app with Fastify's `app.inject()`, so routes, validation, serialization and SQL are exercised
without binding a port. Three suites need more than that:

- **`tests/task.test.ts`** walks the nine success criteria over HTTP, plus the wire contract
  (exact key set, nested `jsonb` round trip), validation, both credential kinds and cross-user
  isolation on every route.
- **`tests/events.test.ts`** binds an **ephemeral port** and drives it with `fetch` —
  `app.inject()` buffers the whole response and an event stream never ends.
- **`tests/durability-restart.test.ts`** spawns `src/index.ts` as a **child process**, submits jobs
  over HTTP, `SIGKILL`s it mid-flight, starts a fresh one and asserts through the API that every
  task survived, that the orphans carry a `requeued_on_restart` event, and that all of them finish.

Start Postgres and migrate first:

```bash
docker compose up -d postgres && pnpm db:migrate && pnpm test:integration
```

> ⚠️ These tests **`TRUNCATE` the tables they touch**. Point them at a throwaway database — running
> them against the full `pnpm docker:up` stack will wipe the data you were looking at, seeds
> included (`pnpm db:seed:reset` puts them back).
>
> ⚠️ **Stop any `pnpm dev` server pointed at the same database first.** It is a second live runner:
> its claim loop will steal the tasks a test just created, and its boot sweep will requeue them.

## Client types

The frontend generates a typed client from this API's OpenAPI document — see the root
[README](../README.md#how-the-frontend-talks-to-the-backend). Route schemas are the contract, so
after changing one, run `pnpm generate:api:live` from the repo root.
