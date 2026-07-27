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
├── lib/
│   ├── errors.ts       AppError subclasses → HTTP status codes
│   └── http.ts         shared TypeBox: id/error/pagination schemas + helpers
├── plugins/            error handler, request context, swagger  (Fastify plugins)
└── modules/
    └── user/           one feature = one folder
        ├── user.routes.ts       HTTP: schemas, status codes. No logic.
        ├── user.service.ts      business logic. No HTTP, no SQL.
        ├── user.repository.ts   SQL. No HTTP, no logic.
        ├── user.schema.ts       TypeBox request/response schemas
        └── user.types.ts        domain types
tests/
├── helpers.ts          buildTestApp() + truncation
└── user.test.ts        integration tests through app.inject()
```

`src/modules/user/` is the reference example — copy it when adding a feature.

## Key endpoints

| Path             | Description               |
| ---------------- | ------------------------- |
| `/api/v1/users`  | Users REST resource       |
| `/api-docs`      | Swagger UI                |
| `/api-docs/json` | OpenAPI JSON (client gen) |
| `/health`        | Health check              |

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

## Testing

`pnpm test` runs `*.spec.ts` next to the source — pure functions, no I/O, safe in a pre-commit hook.

`pnpm test:integration` runs `tests/*.test.ts` against a real database using Fastify's
`app.inject()`, so routes, validation, serialization and SQL are all exercised without binding a
port. Start Postgres and migrate first:

```bash
docker compose up -d postgres && pnpm db:migrate && pnpm test:integration
```

> ⚠️ These tests **`TRUNCATE` the tables they touch**. Point them at a throwaway database — running
> them against the full `pnpm docker:up` stack will wipe the data you were looking at.

## Client types

The frontend generates a typed client from this API's OpenAPI document — see the root
[README](../README.md#how-the-frontend-talks-to-the-backend). Route schemas are the contract, so
after changing one, run `pnpm generate:api:live` from the repo root.
