# AGENTS.md

> Instructions for AI coding assistants (Cursor, Claude Code, GitHub Copilot, etc.)

## Project overview

A small Fastify 5 backend, deliberately kept boring. TypeScript strict mode, ESM-only, Node ≥ 24
(native TS execution, no build step).

The guiding rule: **every non-obvious thing should have an answer to "why is this here?" that points
at a requirement.** This template previously carried CQRS buses, a DI container and DDD mappers;
they were removed because nothing in it needed them. Don't add that kind of machinery back without a
concrete problem that demands it.

## Quick reference

| What                     | Where                                              |
| ------------------------ | -------------------------------------------------- |
| Package manager          | `pnpm` (never npm or yarn)                          |
| Linter + formatter       | Biome (never ESLint or Prettier)                    |
| Validation after changes | `pnpm check` (`biome check && tsc --noEmit`)        |
| Auto-fix formatting      | `pnpm format`                                       |
| Unit tests               | `pnpm test` — no database                           |
| Integration tests        | `pnpm test:integration` — **needs Postgres**        |
| DB migrations            | `pnpm db:migrate` (DBMate)                          |

Always run `pnpm check` after making changes.

## Architecture

One request flows in one direction:

```
route  →  service  →  repository  →  Postgres
 HTTP     logic        SQL
```

- **`*.routes.ts`** — a Fastify plugin. Declares TypeBox schemas, calls a service, sets status
  codes. **No business logic, no SQL.**
- **`*.service.ts`** — exported async functions. Owns the logic. **No HTTP objects, no SQL.**
  Callable from routes, other modules, jobs, and tests.
- **`*.repository.ts`** — exported async functions holding SQL. **No HTTP, no business rules.**

There is no DI container and no bus. Modules import each other's services directly — an `auth`
module calling `import { findUserByEmail } from '../user/user.service.ts'` is correct and expected.

`src/app.ts` registers every plugin and route explicitly. Reading it tells you the whole API surface.

### The engine (`src/engine/`)

`src/engine/` is deliberately **not** a module. It is a standalone orchestration library that
happens to live in this repo: it owns the task queue, the worker pool, handle allocation and the
task lifecycle state machine.

- It **never imports Fastify.** The HTTP layer is one client of it, the tests are another. Anything
  it needs from a request is passed in as an argument.
- Postgres is the source of truth. Everything the engine holds in memory — in-flight abort
  controllers, slot accounting, event subscribers — is either rebuildable from the database or
  safely discarded on restart.
- The `Engine` interface in `src/engine/types.ts` **is** the public surface. `OrchestrationEngine`
  implements it; `createEngine(config)` is the wiring helper that resolves defaults and returns
  one. Nothing outside `src/engine/` imports any other file in there, apart from
  `src/engine/workers/types.ts` — a worker author needs `Worker`, `Job`, `WorkerResult` and
  `WorkerDescriptor`, and those live next to the registry that consumes them rather than in
  `types.ts`. The dependency is one-way: worker types import nothing from `types.ts`.
- The engine knows no lanes. Workers are injected by whoever constructs it — the Fastify plugin in
  production, the test itself in tests. Adding a worker is one entry in one array.
- Persistence is behind `TaskRepository` (`src/engine/repository.types.ts`). `EngineConfig.repository`
  defaults to `postgresTaskRepository` in `createEngine()`, and that is the only place the Postgres
  implementation is named. **`withTransaction`, the raw SQL and `#src/db.ts` stay inside
  `src/engine/repository.ts`** — one interface method per *operation*, never per query, so a
  transaction boundary never reaches a caller. It is a seam, not portability: the contract is still
  shaped by `FOR UPDATE SKIP LOCKED` claiming and guarded conditional updates.

The route → service → repository rule above applies to `src/modules/*`, not here.

`src/plugins/engine.ts` is the one place the engine, the process environment and the Fastify
lifecycle meet. It reads every `ENGINE_*` variable, holds the `workers` array (**adding a lane is
one entry in it**), decorates `app.engine`, starts the claim loop in `onReady` and drains it in
`preClose`. Autostart defaults to `NODE_ENV !== 'test'` and `buildTestApp()` turns it off
explicitly — a live claim loop racing `truncateAll()` poisons unrelated suites, so a test that
needs work to execute calls `await app.engine.start()` itself.

`preClose` rather than `onClose` is deliberate: `onClose` hooks run LIFO, so the `closeDb()` hook
`src/index.ts` registers after `buildApp()` would run first and pull the connection out from under
a draining worker.

`src/modules/task/` is the engine's HTTP surface and has **no service and no repository** — the
engine is the service layer. A handler reads the caller, calls one engine method, shapes the
answer. That is the whole file.

## Adding a module

Copy `src/modules/apikey/` — it is the reference implementation. (`src/modules/user/` has no
routes: it is the data layer the auth module calls, kept deliberately without an HTTP surface.)

1. `src/modules/<name>/<name>.types.ts` — domain types
2. `src/modules/<name>/<name>.schema.ts` — TypeBox request/response schemas
3. `src/modules/<name>/<name>.repository.ts` — SQL, importing `getDb()` from `#src/db.ts`
4. `src/modules/<name>/<name>.service.ts` — logic, importing the repository
5. `src/modules/<name>/<name>.routes.ts` — a `FastifyPluginAsyncTypebox`
6. Register it in `src/app.ts`: `await app.register(<name>Routes, { prefix: '/api/v1' })`
7. `pnpm db:create-migration <name>` for schema changes
8. Add integration tests in `tests/<name>.test.ts`
9. `pnpm check`

## Auth

`src/plugins/auth.ts` resolves both credential kinds (session JWT cookie/bearer, and `jrk_…` API
keys) in one global `onRequest` hook. Routes opt in with `config: { auth: … }`; a route that
declares nothing is public and pays nothing.

```ts
app.get('/thing',  { config: { auth: true } }, handler)                    // either kind
app.post('/keys',  { config: { auth: { session: true, apiKey: false } } }) // humans only
```

In the object form a kind is allowed only when it is explicitly `true` — omitting one denies it.
Handlers read the caller with `const { userId } = requireAuth(req)`; never touch
`req.authContext` directly and never assert it with `!`.

- **401** — no credential, or invalid/expired/revoked. One message for all of them, on purpose.
- **403** — valid credential, wrong kind for this route.

Passwords go through `#src/lib/password.ts` (scrypt, no native dependency). Never add argon2 or
bcrypt: the production image installs `--prod --ignore-scripts` on Alpine and cannot build them.

## Coding conventions

### Style
- Biome enforces: single quotes, 2-space indent, trailing commas, semicolons, LF, 100 col
- File naming: `kebab-case` (enforced by Biome)
- No enums — use `const` objects with derived types (see `LogLevel` in `src/config/env.ts`)
- Classes where there is lifecycle and mutable state to own (the engine, its runner, the event
  bus). Plain functions everywhere else — modules, services, repositories, pure helpers. A class
  that is only a namespace for stateless functions is a module in disguise; don't write one
- A class with a public contract declares `implements <Interface>`, and that interface is the
  documentation of its surface. Never derive a public type from an implementation with
  `ReturnType<typeof …>`
- Public methods that may be detached (passed as callbacks, destructured, handed to a route) are
  arrow-function properties. Internal helpers are ordinary `private` methods
- Privacy is the TypeScript `private` keyword, not `#`. Node's type stripping **erases `private`
  entirely**, so there is no runtime privacy — a `private` field is an ordinary enumerable property
  and `Object.keys()` will show it. That is accepted: the keyword documents intent and the compiler
  enforces it at the only boundary that matters here
- **Never write a constructor parameter property.** `constructor(private readonly dep: Dep)` is a
  `SyntaxError` under type stripping (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — it is a TS feature that
  emits code rather than erasing. Declare the field, then assign it in the constructor body
- Standalone named functions are `function foo() {}`, not `const foo = () => {}`. Arrows stay where
  they are arguments, callbacks, values in a data structure, or where lexical `this` matters
- No `any` — `noExplicitAny` is an error (relaxed in tests)
- No `console` — use `fastify.log` / the injected logger

### TypeScript
- `strict: true`
- Path aliases `#src/*` and `#tests/*` are Node
  [subpath imports](https://nodejs.org/api/packages.html#subpath-imports) declared in `package.json`,
  not tsconfig
- Always include the `.ts` extension in imports (ESM requirement)
- Prefer `import type { … }` for types

### API
- Routes are registered under `/api/v1` in `src/app.ts`
- Every route declares TypeBox schemas — they validate requests, serialize responses **and** become
  the OpenAPI document the frontend generates its client from
- Give response schemas a `title`; it shows up in the generated spec. Note that the client generator
  names inline types after the operation (`CreateUserBody`, `FindUsers200`).
  `refResolver.buildLocalReference` **is** configured in `src/plugins/swagger.ts`, so a schema
  registered with `$id` via `app.addSchema()` — currently only `ApiErrorResponse` — appears in the
  spec under that name rather than a positional `def-0`. Response schemas stay inline with a `title`
  all the same: naming them via `$id` would cost `$ref` indirection and lose response type
  inference.
- Any list endpoint should use `paginationQuerySchema` / `paginatedResponseSchema` from
  `#src/lib/http.ts`, and its SQL **must** have an `ORDER BY` — pagination without one is
  nondeterministic in Postgres.

#### ⚠ Response schemas STRIP unlisted properties

Fastify serialises with `fast-json-stringify`, which emits **only** the properties the response
schema names. A `jsonb` column typed as `Type.Object({})` serialises `{"duration_ms":500}` as
`{}` — a valid-looking, completely empty response, and a test asserting the key exists still
passes. Anything free-form must be typed permissively:

```ts
Type.Unsafe<Record<string, unknown>>({ type: 'object', additionalProperties: true })  // open object
Type.Unknown()   // emits `{}`, so fast-json-stringify falls back to JSON.stringify
```

`src/modules/task/task.schema.ts` does this for `params`, `result`, `error` and event `detail`, and
`tests/task.test.ts` proves it with a deeply nested payload asserted by **structural equality** —
a key-presence check would pass against a stripped `{}`.

#### The three deliberate divergences in the task API

Recorded here so they read as decisions rather than drift; the reasoning is in `README.md`.

- `GET /tasks` returns a **bare array**, not the house `{count, limit, page, data}` envelope that
  `GET /keys` still uses. The shape is fixed by an external contract, and a reviewer's
  `res.json()[0].handle` must not break on a local convention. The inconsistency is intentional.
- `GET /tasks/{handle}/result` returns **the whole task**, with `result` populated and
  `collected: true`, rather than the bare result value — collecting is a state transition and the
  caller wants the new state with it.
- `GET /lanes` is **public**. Lane names and parameter descriptors only, no user data, and the
  submit form has to render before login.

#### Server-sent events

`@fastify/sse` is registered globally in `src/app.ts`; a route opts in with `sse: 'only'`. Two
things that are not obvious:

- Attach **no response schema** to an SSE route — the serialiser would fight the plugin.
- The plugin commits headers lazily, on the first frame. A stream that has nothing to send yet
  must call `reply.sse.sendHeaders()` **and** `reply.raw.flushHeaders()`, or the client sees
  nothing until the first event (`writeHead` only queues the head; Node puts it on the wire with
  the first body byte).

### Errors
- Throw `AppError` subclasses from `#src/lib/errors.ts` (`BadRequestError`, `UnauthorizedError`,
  `ForbiddenError`, `NotFoundError`, `ConflictError`, `DatabaseError`). The error handler maps them
  to status codes and attaches a correlation id.
- Translate infrastructure errors at the boundary: the repository turns Postgres `23505` into
  `ConflictError` so callers never see a driver error.
- Anything not an `AppError` becomes a logged 500 — internals never reach the client.

### Database
- `getDb()` from `#src/db.ts` returns the lazy singleton connection
- Always use tagged templates — they parameterize automatically:
  ``db`SELECT * FROM users WHERE id = ${id}` ``
- Build optional `WHERE` clauses with `joinConditions()`
- Multi-statement writes go through `withTransaction()`
- Column names are camelCase and must be quoted: `db`"handleNum" = ${x}``

### Testing
- Unit tests: `*.spec.ts` next to the source, pure functions only, no I/O
- Integration tests: `tests/*.test.ts` driving the app with `app.inject()` against a real database
- Use `buildTestApp()`, `truncateAll()` and `ensureDevUser()` from `#tests/helpers.ts`
- `buildTestApp()` builds the engine but does **not** start it. A test that needs work to run calls
  `await app.engine.start()`, and stops it before truncating; pass
  `buildTestApp({ engine: { config: { concurrency: 2 } } })` to tune the runner for one suite
- `app.inject()` cannot test SSE — it buffers the response and a stream never ends. Bind an
  ephemeral port (`app.listen({ port: 0 })`) and drive it with `fetch`
- Anything that must survive a process death spawns `src/index.ts` as a child process. Poll
  `/health` for readiness rather than sleeping, and kill every child in `after`, including on
  failure — an orphaned backend is a second live runner against the test database
- Prefer an integration test over mocking a repository — they're fast (the whole suite runs in
  well under a second) and they actually exercise the SQL

## Common mistakes to avoid

- Putting business logic in a route, or SQL in a service
- Reintroducing a DI container, service locator, or event/command bus
- Forgetting `.ts` extensions in imports
- Using `npm`/`yarn` instead of `pnpm`
- `console.log` instead of the logger
- Adding `enum` types
- Paginating without `ORDER BY`
- Letting a raw driver error escape a repository
