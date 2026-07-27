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

## Adding a module

Copy `src/modules/user/` — it is the reference implementation.

1. `src/modules/<name>/<name>.types.ts` — domain types
2. `src/modules/<name>/<name>.schema.ts` — TypeBox request/response schemas
3. `src/modules/<name>/<name>.repository.ts` — SQL, importing `getDb()` from `#src/db.ts`
4. `src/modules/<name>/<name>.service.ts` — logic, importing the repository
5. `src/modules/<name>/<name>.routes.ts` — a `FastifyPluginAsyncTypebox`
6. Register it in `src/app.ts`: `await app.register(<name>Routes, { prefix: '/api/v1' })`
7. `pnpm db:create-migration <name>` for schema changes
8. Add integration tests in `tests/<name>.test.ts`
9. `pnpm check`

## Coding conventions

### Style
- Biome enforces: single quotes, 2-space indent, trailing commas, semicolons, LF, 100 col
- File naming: `kebab-case` (enforced by Biome)
- No enums — use `const` objects with derived types (see `UserRole` in `user.types.ts`)
- No classes for business logic — plain functions
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
  names inline types after the operation (`CreateUserBody`, `FindUsers200`). If you want stable
  hand-picked names instead, register schemas with `$id` via `app.addSchema()` and configure
  `refResolver.buildLocalReference` in `src/plugins/swagger.ts` — deliberately not done here, since
  it costs `$ref` indirection and loses response type inference.
- Any list endpoint should use `paginationQuerySchema` / `paginatedResponseSchema` from
  `#src/lib/http.ts`, and its SQL **must** have an `ORDER BY` — pagination without one is
  nondeterministic in Postgres.

### Errors
- Throw `AppError` subclasses from `#src/lib/errors.ts` (`BadRequestError`, `NotFoundError`,
  `ConflictError`, `DatabaseError`). The error handler maps them to status codes and attaches a
  correlation id.
- Translate infrastructure errors at the boundary: the repository turns Postgres `23505` into
  `ConflictError` so callers never see a driver error.
- Anything not an `AppError` becomes a logged 500 — internals never reach the client.

### Database
- `getDb()` from `#src/db.ts` returns the lazy singleton connection
- Always use tagged templates — they parameterize automatically:
  ``db`SELECT * FROM users WHERE id = ${id}` ``
- Build optional `WHERE` clauses with `joinConditions()`
- Multi-statement writes go through `withTransaction()`
- Column names are camelCase and must be quoted: `db`"postalCode" = ${x}``

### Testing
- Unit tests: `*.spec.ts` next to the source, pure functions only, no I/O
- Integration tests: `tests/*.test.ts` driving the app with `app.inject()` against a real database
- Use `buildTestApp()` and `truncateUsers()` from `#tests/helpers.ts`
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
