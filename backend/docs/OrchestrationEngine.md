# The orchestration engine

## 1. What it is

`src/engine/` is a small background job runner: you hand it a job, it hands you back a short handle
(`scrape-1`) immediately, and it runs the work later under a concurrency limit, tracking the job
through `queued → running → ready | failed | cancelled` and emitting an event at every transition.
It is a library, not a module of this application — it never imports Fastify, it knows no lane
names, and the tests drive it with no web server present. One governing idea decides almost every
question below: **Postgres is the state machine and the process is a stateless executor; everything
held in memory is either rebuildable from the database or safe to discard.** The only thing the
runner keeps in RAM is `#inFlight`, a `Map` from task id to the `AbortController` that cancels it.
Kill the process and no fact is lost, because no fact ever lived only in the process.

## 2. Requirements → implementation

The brief lists nine numbered success criteria. Each one maps to code and to a test that proves it.
Test names are quoted exactly as they appear in the `it(...)` strings.

| #   | Criterion                                                                                  | Implementation                                                                                                                                           | Proven by                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Instant handle                                                                             | `OrchestrationEngine.submit` → `allocateAndInsert` (`handles.ts`); the row is written `queued` and returned, and no worker is awaited on the submit path | `accepts a long job and returns immediately` (`lifecycle.test.ts`)                                                                                                                                                                                                                                                                                                                                                     |
| 2   | Lifecycle to ready, result collectable, `accepted` then `ready` on the stream              | `TaskRunner.tick` → `#runOne` → `#succeed`; `OrchestrationEngine.collect`                                                                                | `moves queued → running → ready and hands back the result`; `publishes accepted then ready in the exact wire shape`                                                                                                                                                                                                                                                                                                    |
| 3   | Per-category numbering                                                                     | `repo.nextHandleNum`, scoped by `("userId", lane)`                                                                                                       | `numbers each lane independently`; `gives the second active task on a lane the next number`                                                                                                                                                                                                                                                                                                                            |
| 4   | Recycling without collision                                                                | the partial unique index `tasks_active_handle_uniq`, `repo.nextHandleNum`, `repo.lockLane`, the `23505` retry loop in `allocateAndInsert`                | `recycles a number once its task is collected`; `releases a number when its task is cancelled`; `fills the gap left in the middle of a range`; `keeps a failed task holding its number`; `allocates 1..20 with no collisions under 20 concurrent submits`; `recovers through the 23505 (Conflict Error) retry loop when the lane lock is disabled`; `does not let one user see or collide with another user’s handles` |
| 5   | Failure surfaces with a reason and a `retryable` flag, no auto-collect, operator can retry | `TaskRunner.#fail`; `OrchestrationEngine.retry`                                                                                                          | `records a worker failure with its reason and retryability`; `retries a retryable failure until the attempt budget runs out`; `gives a manually retried task a fresh budget without rewriting its history`                                                                                                                                                                                                             |
| 6   | Cancellation of running and queued jobs, worker actually stops                             | `OrchestrationEngine.cancel` (three guarded updates) + `TaskRunner.abort`                                                                                | `stops a running job and never reports it ready`; `cancels a queued job before its worker ever starts`                                                                                                                                                                                                                                                                                                                 |
| 7   | Concurrency respected                                                                      | slot arithmetic in `TaskRunner.tick` (`concurrency - #inFlight.size`) bounding `repo.claim`'s `LIMIT`, plus the non-reentrancy guard                     | `never runs more than `concurrency` jobs at once, and starts the rest as slots free`                                                                                                                                                                                                                                                                                                                                   |
| 8   | Concurrent completions, nothing lost or duplicated                                         | `TaskRunner.transition` — one guarded `UPDATE` plus its event, in one transaction                                                                        | `runs three short jobs to completion with exactly one ready event each`                                                                                                                                                                                                                                                                                                                                                |
| 9   | Durability across restart                                                                  | `repo.reclaimOrphans` (boot sweep) and `repo.reclaimExpiredLeases` (reaper), both wrapped by `TaskRunner.#requeue`                                       | `recovers work abandoned by a dead runner and finishes all of it`; `reclaims a row whose lease lapsed, recording why`; `does not reclaim the leases of work it is actively running`; `leaves other runners’ work alone when the boot sweep is switched off`                                                                                                                                                            |

**Criterion 9 is only simulated at engine level.** The brief asks that the backend process be killed
and restarted. The durability suite instead calls `stop({ drain: false })`, which clears the timers,
abandons every in-flight job without writing anything, and leaves rows frozen in `running` owned by
a runner id nobody is heartbeating — which is exactly what `SIGKILL` leaves behind. A second engine
with a fresh `runnerId` then recovers them. Killing an actual OS process needs a server to kill, so
that check belongs to the API layer; it exercises this same `reclaimOrphans` code path.

Two further requirements from the quality bar are worth naming here. Every read and write on the
`Engine` surface takes `userId` as its first argument and scopes its SQL by it — proven by
`scopes every read to its user, and filters and sorts the list`, which asserts that another user's
task id is a `NotFoundError` rather than a window into their data. And the fixed four event shapes
are asserted by key set, not just by value, in `publishes accepted then ready in the exact wire shape`, so a stray extra field fails the suite instead of silently changing the API.

## 3. Architecture

```
src/engine/types.ts                 the public surface: Engine, EngineConfig, Task, EngineEvent, Worker
src/engine/index.ts                 createEngine(): resolves defaults, wires registry + bus + runner
src/engine/orchestration-engine.ts  the Engine implementation — submit, get, list, collect, cancel, retry
src/engine/runner.ts                TaskRunner: the claim loop, heartbeat, reaper, and transition writer
src/engine/handles.ts               allocateAndInsert(): handle allocation and its 23505 (Conflict Error) recovery loop
src/engine/repository.ts            every SQL statement the engine issues
src/engine/events.ts                InProcessEventBus, handleOf(), toEngineEvent()
src/engine/workers/registry.ts      lane → descriptor lookup, and parameter validation
src/workers/mock-worker.ts          the stand-in worker — outside the engine, on purpose
```

Two boundary rules hold, and both are checkable with `grep`. `src/engine/` never imports Fastify —
the string appears only in comments explaining why. And `src/engine/` never imports `src/workers/`:
the engine has no default worker set, because `EngineOptions` is
`Partial<Omit<EngineConfig, 'workers'>> & Pick<EngineConfig, 'workers'>`, which makes `workers` the
one field a caller cannot omit. An engine that shipped knowing a lane called `scrape` exists would
have exactly the coupling this arrangement is meant to prevent. `src/engine/index.ts` is the front
door; nothing outside the directory imports any other file in it.

`createEngine()` also never reads `src/config/env.ts`. An engine that read the process environment
could not be instantiated twice with different settings in one process, and two runners with
different ids against one database is precisely what the durability tests need.

## 4. Data model

Two tables. `tasks` holds current state; `task_events` is the append-only transition log.

`tasks` carries the obvious columns (`lane`, `handleNum`, `params jsonb`, `status`, `result jsonb`,
`error jsonb`, `attempts`, `maxAttempts`, `collected`) plus the four that make execution durable:
`runAfter` (when it becomes claimable, which is how backoff is expressed), `leaseUntil`, `runnerId`,
and `isSeed`. `isSeed` marks fixture rows for the dashboard; every claim and recovery statement
carries `AND NOT "isSeed"` so a fixture can look like a running job without ever executing.

The central invariant is one partial unique index:

```sql
CREATE UNIQUE INDEX tasks_active_handle_uniq
  ON tasks ("userId", lane, "handleNum")
  WHERE status IN ('queued','running','failed')
     OR (status = 'ready' AND NOT collected);
```

That `WHERE` clause is the definition of "active", written once and enforced by Postgres. It encodes
the brief's rule directly: a handle may never collide with a job that is queued, running, or
finished-but-uncollected, and a number is released when its job is collected or cancelled. Retired
rows fall out of the index, so many historical `scrape-1` rows may coexist while at most one is
active. Because the constraint is an index rather than application logic, a bug in the allocator
produces a `23505` error, not a duplicate handle.

`status` is `text` with a `CHECK` rather than a Postgres enum, for three reasons. The status set is
frozen by the brief, so the extensibility an enum would buy is worth nothing here. `task_events.type`
is the opposite — a growing vocabulary that already has ten members and gains one whenever the
engine learns to say something new — and growing an enum means `ALTER TYPE`, which is a migration
per word. And a `CHECK` clause is visible in `\d tasks`, whereas an enum's permitted values are not;
an operator reading the schema sees the whole state machine without a second query. The house rules
in `AGENTS.md` forbid TypeScript enums for a related reason, and `TaskStatus` is a `const` object
with a derived type.

`task_events.id` is a `bigserial`. That gives every event a monotonic, per-database ordering, which
is what makes cursor replay possible; the repository narrows it to `number` on the way out, since
the driver returns `bigserial` as a string.

## 5. The lifecycle of one task

**Submit.** `OrchestrationEngine.submit` first calls `registry.validateParams(lane, params)`, which
throws `BadRequestError` for an unknown lane or a parameter that fails its descriptor, and returns
normalised params (defaults applied, numeric strings coerced). It then calls `allocateAndInsert`,
which opens a transaction, takes the per-lane advisory lock, computes the next free handle number,
inserts the `tasks` row as `queued`, and inserts the `accepted` event — all inside the same
transaction, so a task can never exist without its first event. After the transaction commits,
`submit` publishes `accepted` on the bus and returns the task. No worker has run; nothing has been
awaited except Postgres.

**Claim.** `TaskRunner.tick` computes `concurrency - #inFlight.size` and, if that is positive, calls
`repo.claim`, which in one statement selects that many `queued` rows and flips them to `running`,
increments `attempts`, stamps `runnerId` and sets `leaseUntil = now() + leaseMs`. Each claimed row
gets a fresh `AbortController` recorded in `#inFlight`, and `#runOne` is launched without `await` —
awaiting would serialise the pool down to one job.

**Run.** `#runOne` writes the `started` event first (`#recordStarted`), checks that a worker is
registered for the lane, and then races the worker's promise against a `jobTimeoutMs` timer. The
worker is called as `handler(toJob(task), { signal: ac.signal })`.

**Settle.** `#settle` routes a `ready` result to `#succeed` and a `failed` result to `#fail`. Both
go through `TaskRunner.transition`, which is the only writer of `tasks.status` outside `claim`. One
transaction: a guarded `UPDATE` (`repo.updateTask`) and the matching `insertEvent`. If the guard
matched, commit and _then_ publish; if it did not, return `null` and publish nothing. Finally,
`#runOne`'s `finally` clears the timer, deletes the task from `#inFlight`, and calls `#scheduleTick`
so the freed slot is filled on the next turn of the event loop rather than at the next poll interval.

Transaction boundaries, stated plainly: allocation is one transaction; each transition is one
transaction; a recovery sweep is one transaction covering every reclaimed row and all its events.
The `started` event is the one write that does not share a transaction with a status change, because
`claim` already wrote the status atomically and `#runOne` is only recording that the handler was
entered.

## 6. Handle allocation and recycling

This is the racy part, so it lives in its own file.

A handle is `lane-N` where N is the smallest number not held by an active task of that user and
lane. Numbers are recycled, so the allocator has to fill gaps rather than count upwards. The query
in `repo.nextHandleNum`:

```sql
WITH used AS (
  SELECT "handleNum" AS n FROM tasks
  WHERE "userId" = ${userId} AND lane = ${lane}
    AND (status IN ('queued','running','failed') OR (status = 'ready' AND NOT collected))
)
SELECT COALESCE(MIN(s.n), 1) AS n
FROM generate_series(1, (SELECT COALESCE(MAX(n), 0) + 1 FROM used)) AS s(n)
WHERE NOT EXISTS (SELECT 1 FROM used WHERE used.n = s.n)
```

`used` repeats the predicate of `tasks_active_handle_uniq` exactly. The `generate_series` runs from
1 to one past the highest used number, so if `{1,2,4}` are taken it considers `{1,2,3,4,5}` and the
lowest missing one is 3. If nothing is used the series is `1..1` and the answer is 1. This is what
`fills the gap left in the middle of a range` asserts, against a naive max-plus-one allocator that
would have said 3 where the correct answer is 1.

Before that query runs, `repo.lockLane` takes
`pg_advisory_xact_lock(hashtext(${userId}), hashtext(${lane}))`. Without it the gap query is a pure
race: under READ COMMITTED every concurrent submitter reads the same snapshot, picks the same
number, and exactly one wins the unique index, so N concurrent submits on one lane need O(N)
retries — and postgres.js pools ten connections, so ten simultaneous submits is an ordinary Tuesday
rather than a thought experiment. The lock is an `xact` lock, released on commit or rollback with
nothing to leak.

**The retry loop exists anyway**, and this is the important part. The advisory lock is an
optimisation; `tasks_active_handle_uniq` is the invariant. `allocateAndInsert` wraps `allocateOnce`
in a loop of `MAX_ALLOCATION_ATTEMPTS` (5), catches only errors for which `repo.isUniqueViolation`
returns true, and retries — the loser re-reads a snapshot that now contains the winner's committed
row and takes the next number. Anything that is not a `23505` is rethrown untouched. Exhausting the
five attempts throws a `ConflictError` naming the lane. Correctness must not depend on an advisory
lock, and `recovers through the 23505 retry loop when the lane lock is disabled` is what turns that
sentence from a comment into a proof: it passes `useLaneLock: false`, fires three concurrent
allocations straight at the race, and asserts they land on `[1, 2, 3]` with three distinct
`accepted` events.

`isUniqueViolation` walks the `cause` chain up to five links deep, because the house rule is that a
repository never leaks a driver error — `guarded()` translates `23505` into `ConflictError` with the
original attached as `cause` — but `handles.ts` genuinely needs to tell a lost handle race apart
from any other conflict.

**Which states hold a number.** Active, and therefore holding: `queued`, `running`, `failed`, and
`ready AND NOT collected`. Released: `cancelled`, and `ready AND collected`. The brief recycles on
"collected or cancelled" and calls "finished-but-uncollected" active, which leaves `failed` in an
awkward position; the engine resolves it by treating `failed` as active, since a failed task is
still on the operator's screen waiting for a decision. That has a consequence: without an escape
hatch, `scrape-3` would be held forever by a task nobody will ever retry. So `cancel` accepts
`failed` as a source state and doubles as "dismiss". `dismisses a failed task, releasing its handle number` walks the whole sequence — the failed task holds `scrape-1` so the next submit is `scrape-2`,
then cancelling it hands `scrape-1` straight back.

`handleOf(lane, handleNum)` is the one place `lane-N` is spelled out, and `parseHandle` splits on
the _last_ hyphen, so a lane name may itself contain one (`page-scrape-4` is `page-scrape` #4).
The handle is never stored: `toTask` derives it from the row, so two columns cannot disagree.

`findByHandle` orders by `"createdAt" DESC LIMIT 1`, because a `(userId, lane, handleNum)` triple
may match many historical rows. At most one can be active, and the newest is that one whenever any
is active — and the most useful answer when none is.

## 7. Concurrency

Node runs one thread. That is not a limitation for this workload, because the jobs are I/O-bound: a
worker awaiting a `fetch` or a query holds no CPU while it waits, so twenty of them make progress on
one event loop just as well as on twenty. What a single thread cannot give you is parallelism — two
workers computing simultaneously. `WorkerDescriptor.kind` exists for that day. It is a union of one
member (`'inline'`) today, and the registry hands callers a _descriptor_ rather than a function
precisely so that adding `'thread'` or `'external'` is a change in `workers/registry.ts` and nowhere
else. A CPU-bound lane would be registered with a different `kind` and dispatched to a worker thread
or an external process; nothing in the claim loop, the lease, or the state machine would change,
because none of it knows what a handler does.

An in-process pool is the right shape here for two reasons that are both graded behaviours.
Cancellation becomes an in-memory `AbortController` lookup — `TaskRunner.abort(taskId)` — instead of
a cancellation flag written to the database and polled by a separate process. And a completion event
reaches subscribers through an in-memory emitter instead of requiring Postgres `LISTEN/NOTIFY` just
to cross a process boundary. Because the claim loop coordinates entirely through Postgres, the split
remains available later, at the cost of a configuration change plus a `NotifyEventBus` satisfying
the same two-method `EventBus` interface.

Three mechanisms keep the limit honest.

`tick` is **non-reentrant**: it returns immediately if `#ticking` is already true. Two overlapping
ticks would each compute slots from the same `#inFlight.size` and each claim that many rows, so the
pool would run at up to twice its concurrency, and every subsequent tick would compound the error.

`claim` uses `FOR UPDATE SKIP LOCKED`, so a row another runner is mid-claim is skipped rather
than waited on. N runners claim N disjoint sets with no coordination:

```sql
UPDATE tasks t SET
  status = 'running', attempts = t.attempts + 1, "runnerId" = ${runnerId},
  "leaseUntil" = now() + ${leaseMs} * interval '1 millisecond', "updatedAt" = now()
WHERE t.id IN (
  SELECT id FROM tasks
  WHERE status = 'queued' AND NOT "isSeed" AND "runAfter" <= now()
  ORDER BY "createdAt"
  LIMIT ${limit}
  FOR UPDATE SKIP LOCKED
)
RETURNING t.*
```

`ORDER BY "createdAt"` makes the queue FIFO. `"runAfter" <= now()` is how backoff is expressed — a
task waiting out its backoff is simply not yet claimable.

And the limit is asserted from _inside_ the worker. The gate worker in `tests/engine/gate-worker.ts`
counts overlapping invocations and keeps a high-water mark, so
`never runs more than `concurrency` jobs at once, and starts the rest as slots free` proves that
three concurrent jobs never existed, rather than that a sampler never happened to see three.

## 8. Cancellation

`OrchestrationEngine.cancel` reads the task, then tries three conditional updates in order —
`from queued`, `from running`, `from failed` — and stops at the first that matches. Three rather
than one, because the correct follow-up differs per state and the code has to know which one landed:

- **queued** — the claim loop was beaten to it. Nothing is running, nothing to abort.
- **running** — write the terminal state first, _then_ call `this.#runner.abort(task.id)`.
- **failed** — the dismiss path described in section 6.

If none matched, the task changed state between the read and the write; `cancel` re-reads it and
throws a `ConflictError` naming what it actually is, rather than returning a cancelled-looking task
that is really `ready`. `refuses to cancel a task that finished in the gap, and leaves it intact`
covers that, asserting no `cancelled` event was written.

**Why the terminal state is written before the abort.** Aborting first lets the worker's promise
reject, `#runOne` reach its error path, and `#fail` overwrite `cancelled` with `failed` before the
cancel update ever lands. Writing first closes that window. `#runOne` also checks
`ac.signal.aborted` at both of its exits and returns without transitioning, and every transition
carries a guard, so there are three independent defences; the ordering is the one that makes the
intent explicit rather than relying on a `WHERE` clause.

`stops a running job and never reports it ready` asserts all of it: status `cancelled`, the abort
observed _inside_ the worker (`gate.aborted`), no `ready` and no `failed` event on the bus, and a
history of exactly `['accepted', 'started', 'cancelled']`.

## 9. Failure, retry, backoff

`TaskRunner.#fail` makes one decision: retry or die. If the error is `retryable` and
`attempts < maxAttempts`, the task goes back to `queued` with `runAfter` set to now plus
`#backoffFor(attempts)`, and a `retry_scheduled` event records the attempt number, the reason, the
backoff and the new `runAfter`. Otherwise it goes to `failed` with a `failed` event. Both paths are
guarded on `status = 'running'` and `runnerId = <me>`, so a task cancelled underneath is not
resurrected.

`#backoffFor` is `backoffBaseMs * 2 ** Math.max(0, attempts - 1)`, capped at `backoffMaxMs`, then multiplied by
up to 1.2 (`JITTER = 0.2`) so that retries of a burst do not re-synchronise.

A worker that _throws_ rather than returning `{ status: 'failed' }` told the engine nothing about
whether the failure is permanent, so `#runOne` assumes `retryable: true` and lets the attempt budget
decide. A worker that returns `failed` with no `error` gets
`{ reason: 'worker reported a failure with no reason', retryable: false }` — it had the chance to
say and did not.

**What** `retryable` **means.** It describes the _nature of the error_, not the engine's auto-retry
policy. When a retryable error exhausts its budget, the stored error keeps `retryable: true` and the
reason is rewritten to name the exhaustion: `worker failed after 3 attempts: <original reason>`.
Flipping it to `false` would tell an operator "this can never work" when the truth is "this kept
failing and we stopped trying" — which is exactly the case where pressing retry is worth a shot.
`records a worker failure with its reason and retryability` asserts both halves: the reason matches
`/after 1 attempts/` and `retryable` is still `true`.

`OrchestrationEngine.retry` is the manual path, valid only from `failed`. It clears `error` and
`result`, sets `runAfter` to now, and extends the budget to `attempts + config.maxAttempts` rather
than resetting `attempts`. `attempts` is a lifetime counter — one increment per execution, written
by `claim` — and resetting it would make a task that has burned nine attempts report one, which is
the number an operator most needs to trust. `gives a manually retried task a fresh budget without rewriting its history` asserts `attempts === 1, maxAttempts === 2` after the first retry, and the
durability suite asserts the counter never drifts:
`types.filter(t => t === 'started').length === task.attempts`.

## 10. Durability and restart

**Write before act.** Every effect is preceded by its durable record. `claim` writes `running` and
the lease before the handler is entered. `#recordStarted` writes `started` before the worker's first
line runs. `transition` commits before it publishes. The consequence is that the database is never
behind reality — at worst it is ahead, describing work a crash prevented, and "ahead" is recoverable
while "behind" is not.

**Runner identity.** `config.runnerId` defaults to `randomUUID()` in `createEngine`, so a restart is
always a new identity. Every claimed row is stamped with it, and every settling transition is
guarded on `runnerId = <me>`, so a process can only finish work it actually owns.

**Lease and heartbeat.** A claim sets `leaseUntil = now() + leaseMs` (default 30s). `#beat` runs
every `heartbeatMs` (default 10s) and pushes the lease out for every id in `#inFlight`. Three
heartbeats fit inside one lease, so a live process never loses its work; a dead one stops renewing
and its rows become reclaimable within a lease.

**Boot sweep versus lease reaping.** These are two answers to the same question, with different
trade-offs. `reclaimOrphans` runs once inside `start()`, _before any timer starts_, and requeues
every `running` row whose `runnerId IS DISTINCT FROM` this process's. On a single-runner deployment
such a row can only be the residue of a crash, so recovery is instant instead of taking a lease. The
`IS DISTINCT FROM` clause is what keeps it honest — at boot this runner owns nothing, so it is a
no-op then, but it means the sweep can never yank a row out from under this process.
`reclaimExpiredLeases` runs on the heartbeat cadence — deliberately the same interval, so a lease
cannot lapse unnoticed for longer than the loop that was supposed to renew it — and requeues
`running` rows whose `leaseUntil` has passed, excluding this runner's own in-flight ids as cheap
insurance against an event-loop stall reclaiming live work. Both go through `#requeue`, which writes
the reclaim and every announcing event in one transaction, then publishes.

`bootSweep: false` exists for the multi-runner case, and it is not a nicety: a second process
booting would otherwise requeue the live, actively heartbeated work of its peers. With the flag off,
crashed work is recovered by lease expiry alone, at the cost of waiting one `leaseMs`.
`leaves other runners’ work alone when the boot sweep is switched off` pins that behaviour by
planting a `running` row owned by another runner with a one-hour lease and asserting it does not
move.

**At-least-once, stated plainly.** A worker can complete its side effect and the process can die
before `transition` commits. The row is still `running`, it is reclaimed, and it runs again — which
is exactly what the durability test observes when it asserts that the two recovered tasks come back
with `attempts === 2`. Workers must therefore be idempotent, or tolerate duplicates. Exactly-once
would require the worker's side effect and the status write to share a transaction, which is
impossible when the side effect is an HTTP call.

## 11. Timeouts

`jobTimeoutMs` (default 300000, five minutes) is a **liveness backstop, not a per-job SLA**. The
scenario it exists for is a worker that hangs and never looks at its `AbortSignal`. Aborting such a
worker achieves nothing, and because the heartbeat renews the lease of anything still in `#inFlight`,
the reaper never rescues it either — concurrency would silently drop by one, permanently, with no
error and no event. The default is chosen to be longer than any legitimate job in this engine: it
matches the mock worker's own `DURATION_CAP_MS` of 300000. A number tuned to what a job _should_
take belongs on the lane, not here.

`#runOne` **races** the worker against the timer rather than aborting and awaiting. That is the
point: `abort()` is a request a worker is free to ignore, and a worker that ignores it is precisely
the one holding a slot forever. Losing the race frees the slot whether or not the worker ever
unwinds — but it does **not** stop the work. The abandoned worker keeps running in the same process
until it finishes on its own, so effective concurrency can briefly exceed the configured limit.

Two details in `#runOne` matter more than they look. The timer is cleared in a `.finally()` attached
to the race, not only in the outer `finally`, so a job that finishes a millisecond inside its budget
cannot be recorded as timed out while its transitions await Postgres. And a separate `timedOut` flag
is checked _before_ every `ac.signal.aborted` early return, because both a timeout and a
cancellation abort the controller but only the timeout still owes the task a terminal state. Confuse
them and a timed-out task vanishes from `#inFlight` while staying `running` until the reaper stumbles
on it. `does not turn a cancellation into a timeout failure` guards the other direction — a
cancelled task must not end up `failed`.

A timeout is recorded as an ordinary `failed` event with `retryable: true` and
`detail.timedOut = true`, not as a new event type: the four contract shapes are fixed, history
should still say "this failed", and _why_ is what `detail` is for.
`fails a job that never returns, and gives its slot back` asserts the whole chain, including that a
queued job behind the single slot runs afterwards. `never spuriously fails a job that finishes inside its budget, and leaks no timer` counts pending `Timeout` resources across two identical
rounds, so a missing `clearTimeout` shows up as a test failure rather than as a process that refuses
to exit.

## 12. Events

The bus is two methods:

```ts
publish(e: EngineEvent): void;
subscribe(userId: string, cb: (e: EngineEvent) => void): () => void;
```

It is declared in `types.ts` rather than `events.ts` so `EngineConfig` can reference it without an
import cycle, and it is deliberately narrow so a `LISTEN/NOTIFY` implementation can drop in without
the runner changing. `InProcessEventBus` is one `EventEmitter` channel per user id, with
`setMaxListeners(0)` because the default cap of 10 would warn on an ordinary user with a few tabs
open. A subscriber that throws is caught and reported at `error` — isolated, but not ignored, since
a swallowed subscriber bug is a bug nobody can find.

**Commit, then publish.** `transition` publishes only after its transaction has returned, and
`submit` publishes `accepted` only after `allocateAndInsert` has committed. Publishing first lets a
subscriber receive `ready`, immediately `GET` the task, and be told it is still `running` — the
event would be a promise the database has not made yet. Worse, if the transaction then rolled back,
the client would have been told about a state that never existed.

Four event shapes are fixed by the brief and must not drift: `accepted` and `ready` carry a
`summary`, `failed` carries `reason` and `retryable`, and `cancelled` carries nothing extra. The
engine emits six more — `started`, `retry_scheduled`, `requeued_on_restart`, `lease_expired`,
`collected`, `retry_requested` — typed as `InformationalEventType` and carrying their raw `detail`;
clients may ignore them, and the operations dashboard is the reason they exist. All ten share the
`EngineEventBase` fields `id`, `task_id`, `user_id`, `handle`, `lane`. `user_id` is routing metadata
that the HTTP layer strips before it reaches a client which already knows who it is.

`toEngineEvent` projects a stored `task_events` row onto the wire shape, and both the live bus and
`eventsSince()` go through it. That is what makes replay byte-identical to the live stream, which
`publishes accepted then ready in the exact wire shape` asserts directly with a `deepEqual` between
the two. A client that reconnects passes the last `id` it saw; `sinceId` is exclusive; events are
durable in `task_events` regardless, so the bus is an optimisation over polling and never the source
of truth.

## 13. Workers

A worker is a function plus a description of itself:

```ts
type Worker = (job: Job, ctx: WorkerContext) => Promise<WorkerResult>;

interface WorkerDescriptor {
  lane: string;
  kind: "inline";
  handler: Worker;
  params: ParamDescriptor[];
  description?: string;
}
```

`Job` and `WorkerResult` are the brief's shapes unchanged. The second argument is a **deliberate
deviation**: the brief's signature is `(job) => Promise<WorkerResult>`, with no cancellation channel,
and "a running worker must actually stop when its job is cancelled" is impossible to honour without
one. With only `(job)` the engine can mark a row `cancelled` while the worker keeps burning the slot
for the rest of its natural life. The addition is backwards compatible — a worker that ignores `ctx`
still type-checks and still runs.

`ParamDescriptor` (`name`, `type`, `required`, `default`, `description`, `min`, `max`) drives two
things: `registry.validateParams` at submit time, and `Engine.lanes()`, which returns the descriptor
minus its unserialisable handler so a UI can render a submission form without hard-coding anything
about a lane. `min`/`max` are a small addition over the brief's field list, added because the mock
worker must cap `duration_ms` at 300000 and a bound in the descriptor is discoverable by `lanes()`
while one buried in the handler is not. Validation is strict for declared params and permissive for
everything else: undeclared keys ride along untouched, because the `jsonb` column exists so that
arbitrary caller metadata survives a round trip. Numeric strings coerce (query strings have no
number type); booleans accept only `true`/`false` in either form.

`mockWorkers` in `src/workers/mock-worker.ts` registers the same handler under `scrape` and
`report`, which is what makes per-lane numbering visible: `scrape-1` and `report-1` exist at once.
The handler sleeps for `params.duration_ms` — defaulting to a random 3000–15000ms — via
`abortableSleep`, which clears its timer on abort so a cancelled 15-second job does not keep the
event loop alive for the full 15 seconds and block `stop({ drain: true })`. `params.fail === true`
returns a _retryable_ failure on purpose: that is the interesting case, since it lets a test watch
the backoff schedule run and the attempt budget drain.

Adding a lane is one entry in one array passed to `createEngine({ workers: [...] })`.

## 14. Design decisions

**A hand-rolled queue rather than pg-boss or BullMQ.** The brief asks for something "small,
observable, and yours" and weights orchestration correctness first — adopting a queue library would
outsource the graded part. There is also a technical objection. The brief requires the engine be
"the single source of truth" for task state, and both alternatives keep their own job state: pg-boss
in its own tables, BullMQ in Redis. Either way there are two records of what a job is doing, and
they have to agree across exactly the restart scenario the brief says it verifies hardest. Neither
provides per-lane handle numbering or recycling, which is the other thing evaluated closely, so that
code would have been written by hand regardless — on top of a queue whose own state now has to be
reconciled with it.

**An in-process worker pool rather than a separate worker process.** Covered in section 7:
cancellation becomes an in-memory `AbortController` rather than a signal routed through the
database, and completion events reach subscribers through an in-memory emitter rather than requiring
`LISTEN/NOTIFY`. Both are graded behaviours, and both get simpler. Because coordination is entirely
in Postgres, splitting later is a configuration change plus one new `EventBus` implementation.

**Why a single thread is not a limitation.** The work is I/O-bound, so concurrency without
parallelism is exactly what is needed, and `WorkerDescriptor.kind` is the declared seam for the day
a CPU-bound lane arrives.

`text` **+** `CHECK` **over a Postgres enum.** Section 4.

**Adding** `id` **to the task object.** The brief fixes field _names and shapes_; an additive field does
not break a conformant client. It is necessary, not decorative: handles are explicitly recyclable
and therefore not stable identifiers — three different tasks can be `scrape-1` over an afternoon —
while a dashboard must be able to list and link retired tasks. `getById` is the read that needs it,
and `recycles a number once its task is collected` asserts `second.id !== first.id`.

**Classes only where there is lifecycle and mutable state.** `TaskRunner` owns timers, `#inFlight`
and the tick guard. `InProcessEventBus` owns an emitter. `OrchestrationEngine` owns its resolved
dependencies and `implements Engine`. Everything else — `handles.ts`, `repository.ts`,
`workers/registry.ts`, `toTask`, `toJob`, `handleOf`, `toEngineEvent` — is plain functions, because
a class that is only a namespace for stateless functions is a module in disguise. The public type is
the hand-written `Engine` interface, which is the documentation of the surface, rather than
`ReturnType<typeof createEngine>` — a derived type documents nothing and changes silently.

`#private` **fields rather than TypeScript** `private`**.** This backend runs TypeScript directly under
Node's type stripping, with no build step. `private` is a type-level annotation: it erases, and at
runtime `this.#registry` written as `private registry` would be an ordinary enumerable public
property. `#` is a real JavaScript private field, enforced by the runtime, and it survives erasure.
`grep -rn "private " src/engine/` finds only a comment.

**Every public method is an arrow-function property.** The `Engine` interface promises its methods
survive being destructured or handed to a callback, which is how a Fastify route will use them.
`keeps working when its methods are pulled off the instance` destructures eight of them, including
the closure returned by `subscribe`, and would fail if any were turned back into an ordinary method.

**Workers injected, never defaulted.** Enforced structurally by the type of `EngineOptions`, which
makes `workers` the single required field, and by the absence of any `src/workers` import inside
`src/engine`. The test harness inherits the enforcement — every test has to say out loud which lanes
it registers, which makes each one a worked example of wiring the engine up.

**The boot sweep alongside lease expiry.** Section 10: instant recovery for the single-process
deployment this targets, versus multi-runner safety, with `bootSweep: false` as the switch between
them.

**Racing the timeout rather than aborting and awaiting.** Section 11: `abort()` is a request a
worker may ignore, and such a worker is exactly the one holding a slot forever.

## 15. Deviations from the brief

1. `Worker` **takes a second** `ctx` **argument** carrying an `AbortSignal`. Without it, "a running
   worker must actually stop when cancelled" cannot be honoured. Backwards compatible.
2. `cancel` **accepts** `failed` **as a source state**, where the brief allows only queued and running.
   Without it a failed task holds its handle number permanently, since the brief recycles only on
   collect or cancel.
3. `ParamDescriptor` **gains** `min` **and** `max`, so the mock worker's `duration_ms` cap is
   discoverable through `lanes()` rather than buried in a handler.
4. **The task object carries additive fields**: `id`, `userId`, `handleNum`, `attempts`,
   `maxAttempts`, `runAfter`, `leaseUntil`, `runnerId`, `collectedAt`, `isSeed`. Every field the
   brief fixes is present. Note that the engine returns them in camelCase with `Date` values —
   `createdAt`, not `created_at`. **The brief's exact wire shape is the HTTP layer's responsibility,
   and that layer is not written yet.** This is the one place where the current code does not
   literally match the brief's fixed field names, and it is deliberate: the engine's surface is
   TypeScript, not JSON.
5. **Events carry** `id`**,** `task_id` **and** `user_id` in addition to the fixed fields. `id` is what
   makes cursor replay work; `user_id` is routing metadata the HTTP layer strips.
6. **Six informational event types** beyond the fixed four. Clients may ignore them; the operations
   dashboard is why they exist.
7. **A per-job timeout** the brief does not mention, as a liveness backstop (section 11).
8. **A** `retryable` **error that exhausts its budget keeps** `retryable: true`**.** The brief groups
   "repeated exhaustion of retries" under permanent failures. The engine agrees about the _policy_ —
   it stops auto-retrying and hands the decision to the operator — but reports the error's nature
   honestly, so the operator can tell "worth another go" from "will never work".
9. `useLaneLock` exists on `AllocateOptions` purely so one test can disable the advisory lock
   and exercise the `23505` recovery path. Production never sets it.

## 16. Limitations, and what I would change with more time

- **At-least-once, not exactly-once.** A crash between a worker's side effect and its status write
  re-runs the job. Workers must be idempotent. Fixing this properly means an idempotency key the
  worker's own side effect is keyed on, which is a worker-contract change, not an engine one.
- **The boot sweep is not multi-runner safe.** With `bootSweep: true` — the default — a second
  process booting requeues the live, heartbeated work of its peers. `bootSweep: false` is the
  correct setting for more than one runner, and it is opt-out rather than detected.
- **Concurrency is global and FIFO, with no fairness.** One user submitting two hundred jobs starves
  everyone behind them until the queue drains. Per-lane limits and a fair-share ordering key would
  both be small changes to `claim`, and neither is implemented.
- `stop({ drain: true })` **leaves aborted rows in** `running` **with a live lease.** It aborts, waits
  up to `DRAIN_TIMEOUT_MS` (5000) for `#inFlight` to empty, and writes nothing — the work is
  genuinely unfinished and the process refuses to guess an outcome. Recovery then takes a full
  `leaseMs`, not the boot sweep: those rows carry _this_ runner's id, and `reclaimOrphans` skips
  rows it owns, so restarting the same engine instance leaves them for the reaper. Only a genuinely
  new process, with a new `runnerId`, sweeps them immediately. Writing them back to `queued` during
  drain would remove the delay entirely.
- **A timeout frees the slot without necessarily stopping the work.** The abandoned worker keeps
  running in the same process, so effective concurrency can briefly exceed the limit. There is no
  fix inside a shared process; a `kind: 'thread'` lane could be killed outright.
- **Results are stored in** `jsonb`**.** A real scraper returns a file, and object storage is where it
  belongs. Anything large will bloat rows and every `SELECT *` that touches them.
- `task_events` **grows without bound.** No retention, no partitioning, no archival. A busy engine
  writes several rows per task per attempt, forever.
- `useLaneLock` **is a test-only flag living in production code.** It is documented and defaults to
  the safe value, but it is still test scaffolding on a production type.
- **The** `23505` **test asserts the outcome, not the branch.** `recovers through the 23505 retry loop when the lane lock is disabled` proves three racing allocations land on `[1, 2, 3]`; it does not
  prove the retry loop executed rather than the race simply not occurring. The collision count was
  measured with a temporary probe (three racers, three collisions, settled by the third attempt) and
  the comment records it, but the assertion is timing-independent on purpose. An injectable counter
  would close the gap.
- `hashtext` **collisions serialise unrelated lanes.** `pg_advisory_xact_lock(hashtext(userId), hashtext(lane))` takes two 32-bit hashes. Two different `(user, lane)` pairs whose hashes collide
  queue behind each other. The cost is throughput, never correctness — but it is invisible when it
  happens.
- **The engine is coupled to the concrete** `TaskRunner`**.** `OrchestrationEngine` takes a `TaskRunner`,
  not a `Runner` interface, so `cancel` and `collect` reach a class rather than a contract. Every
  other dependency (registry, bus, logger) is an interface; this one is the exception.
- **The default logger is silent.** Right for a library — an embedded engine must not print to
  someone else's stdout — but it means an engine nobody gave a logger to records nothing at all.
  A lease reclaimed, a subscriber that threw, a background loop that died: all invisible.

## 17. Configuration reference

Every field of `EngineConfig`, with the default `createEngine()` applies. Only `workers` is
required; `EngineOptions` makes everything else optional.

| Field            | Default                         | Controls                                                                                                                                                          |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers`        | _(required)_                    | The lanes this engine can run. `WorkerDescriptor[]`.                                                                                                              |
| `concurrency`    | `4`                             | Maximum jobs in flight in this process at once.                                                                                                                   |
| `pollIntervalMs` | `200`                           | How often the claim loop runs when idle. A freed slot also triggers an immediate tick via `#scheduleTick`, so this bounds latency only when nothing is finishing. |
| `leaseMs`        | `30_000`                        | How long a claimed row stays owned before another runner may steal it.                                                                                            |
| `heartbeatMs`    | `10_000`                        | How often in-flight leases are bumped. Must be comfortably below `leaseMs`. Also the lease reaper's cadence.                                                      |
| `maxAttempts`    | `3`                             | Attempts a freshly submitted task gets before it is declared failed. Also the increment a manual `retry()` adds.                                                  |
| `backoffBaseMs`  | `500`                           | First retry delay; doubles per attempt.                                                                                                                           |
| `backoffMaxMs`   | `30_000`                        | Ceiling on the exponential backoff, before up to 20% jitter.                                                                                                      |
| `bootSweep`      | `true`                          | Requeue every `running` row this process does not own, once, at `start()`. Set `false` for a multi-runner deployment.                                             |
| `jobTimeoutMs`   | `300_000`                       | Liveness backstop. A job still running after this is aborted and the attempt failed as retryable.                                                                 |
| `bus`            | `new InProcessEventBus(logger)` | Where transitions are published.                                                                                                                                  |
| `logger`         | silent no-op                    | Where background failures go. A pino logger — including Fastify's `app.log` — is structurally assignable with no adapter.                                         |
| `runnerId`       | `randomUUID()`                  | Identifies this process in `tasks.runnerId`. A restart must produce a new one.                                                                                    |

`config` is exposed read-only on the engine, which is what `assert.equal(engine.config.concurrency, 4)`
in the cancellation suite reads.

## 18. Testing

Everything under `tests/engine/` is an integration test against a real Postgres
(`docker compose up -d postgres && pnpm db:migrate`, then `pnpm test:integration`). No repository is
mocked: the SQL _is_ the logic here, and a mocked repository would prove nothing about a partial
unique index.

The scaffolding is `tests/engine/gate-worker.ts`. The **gate worker** starts, records that it
started, and blocks until the test explicitly releases it. That turns every timing question — "did
the third job wait for a slot?", "did cancelling actually stop the work?" — into a question about an
event the test itself caused, rather than a race against `setTimeout`. There is not one sleep-based
assertion in the suite; `settleFor(ms)` appears only in "prove it does _not_ do X" checks, where
waiting is the point. `engineHarness()` tracks every engine a test creates so `afterEach` can drain
them all, which matters because an engine left running would claim rows the next test inserts.

What each file proves: `handles.test.ts` — allocation, recycling, gap-filling, per-user isolation,
the concurrent-submit race and its recovery path. `lifecycle.test.ts` — the happy path, the wire
shapes, history ordering, `jsonb` round-tripping, parameter validation, manual retry, and detached
methods. `concurrency.test.ts` — the limit, measured from inside the worker, and three concurrent
completions with exactly one `ready` event each. `cancel.test.ts` — running, queued, too-late, and
dismiss-a-failure. `durability.test.ts` — the simulated crash, the boot sweep, lease reaping, and
the heartbeat holding a live lease. `timeout.test.ts` — a worker that hangs and ignores its signal,
timer-leak counting, and cancellation not being mistaken for a timeout. `logger.test.ts` — the four
things worth logging, that a healthy engine says nothing above `debug`, and a compile-time proof
(`Satisfies<FastifyBaseLogger, EngineLogger>`) that a pino logger fits `EngineLogger` — written in a
test file precisely so the engine itself never imports Fastify.

**What is deliberately not tested here.** Killing a real OS process — that belongs to the API layer
(section 2). Anything HTTP: routes, API keys, SSE framing and the brief's snake_case wire shape are
all the API layer's, and none of it exists yet. Multi-runner behaviour beyond
`leaves other runners’ work alone when the boot sweep is switched off`; there is no test of two live
engines competing for the same queue, though `FOR UPDATE SKIP LOCKED` is what would make it work.
The retry _branch_ in `allocateAndInsert`, as opposed to its outcome (section 16). And there are no
unit tests (`*.spec.ts`) for the engine at all — the house rule prefers an integration test over a
mocked repository, and the only genuinely pure functions here (`parseHandle`, `handleOf`,
`toEngineEvent`) are exercised through it.
