# The orchestration engine

`src/engine/` runs background jobs. You hand it a job, it gives you back a handle like `scrape-1`
straight away, and it runs the work later under a concurrency limit. Tasks move through
`queued → running → ready | failed | cancelled`, and every transition writes an event.

It's a library, not part of the app. It never imports Fastify, it doesn't know any lane names, and
the tests run it with no web server around.

One idea drives most of the design: **Postgres holds the state, the process is just an executor.**
The only thing kept in memory is a map of task id to `AbortController`. Kill the process and nothing
is lost, because nothing ever lived only in the process.

## Files

```
types.ts                 Engine, EngineConfig, Task, EngineEvent, Worker
index.ts                 createEngine() — resolves defaults, wires everything up
orchestration-engine.ts  submit, get, list, collect, cancel, retry
runner.ts                the claim loop, heartbeat, lease reaper, transition writer
handles.ts               handle allocation and its retry loop
repository.ts            all the SQL
events.ts                the in-process event bus
workers/registry.ts      lane lookup and parameter validation
```

Workers live outside, in `src/workers/`. The engine has no default set — `workers` is the one config
field you can't omit. An engine that shipped knowing a lane called `scrape` exists would have exactly
the coupling this is meant to avoid.

## One task, start to finish

**Submit.** Validate the params against the lane's descriptors, then open a transaction: take a
per-lane advisory lock, find the next free handle number, insert the task as `queued`, insert the
`accepted` event. All in one transaction, so a task can't exist without its first event. Publish
after the commit, then return. No worker has run yet.

**Claim.** The runner works out how many slots are free (`concurrency - inFlight.size`) and claims
that many rows in a single statement, flipping them to `running`, bumping `attempts`, and stamping a
lease. Each one gets an `AbortController` and is launched without `await` — awaiting would collapse
the pool to one job at a time.

**Run.** Write the `started` event, then race the worker's promise against the job timeout.

**Settle.** Success and failure both go through `transition`, which is the only thing that writes
`tasks.status` apart from `claim`. One transaction: a guarded `UPDATE` plus its event. If the guard
matched, commit and then publish. If it didn't, do nothing.

## Handles

A handle is `lane-N`, where N is the lowest number not currently held by an active task of that user
and lane. Numbers get recycled when a task is collected or cancelled, so the allocator has to fill
gaps rather than count upwards. If `{1, 2, 4}` are taken, the next one is 3.

What counts as "active" is defined once, as an index:

```sql
CREATE UNIQUE INDEX tasks_active_handle_uniq
  ON tasks ("userId", lane, "handleNum")
  WHERE status IN ('queued','running','failed')
     OR (status = 'ready' AND NOT collected);
```

Postgres enforces it, not the application. Retired rows drop out of the index, so plenty of historic
`scrape-1` rows can coexist while only one is live. A bug in the allocator produces a unique
violation, not a duplicate handle.

Concurrent submits on the same lane take an advisory lock first. Without it, every submitter reads
the same snapshot, picks the same number, and all but one lose. The lock is an optimisation though —
the index is the real guarantee. `allocateHandleAndInsert` catches unique violations and retries up
to five times, and there's a test that turns the lock off to prove that path works.

`failed` counts as active, since a failed task is still on someone's screen waiting for a decision.
That would leave a number held forever by a task nobody retries, so `cancel` also accepts `failed`
and doubles as "dismiss".

Handles aren't stored. They're derived from the row, so two columns can't disagree. And since
handles are recycled, they're not stable identifiers — `getById` exists for anything that needs to
point at one specific task later.

## Concurrency

Node is single-threaded, which is fine here because the jobs are I/O-bound. A worker waiting on a
`fetch` isn't using the CPU, so twenty of them make progress on one event loop. What you don't get
is parallelism. `WorkerDescriptor.kind` is the seam for that: it's a union of one member today, and
a CPU-bound lane would be registered with a different kind and dispatched to a worker thread. None
of the claim loop, the lease, or the state machine would change.

Three things keep the limit honest:

`tick` is non-reentrant. Two overlapping ticks would each compute free slots from the same count and
each claim that many rows, so the pool would run at double its limit and compound from there.

`claim` uses `FOR UPDATE SKIP LOCKED`, so a row another runner is mid-claim gets skipped instead of
waited on:

```sql
UPDATE tasks t SET
  status = 'running', attempts = t.attempts + 1, "runnerId" = ${runnerId},
  "leaseUntil" = now() + ${leaseMs} * interval '1 millisecond'
WHERE t.id IN (
  SELECT id FROM tasks
  WHERE status = 'queued' AND NOT "isSeed" AND "runAfter" <= now()
  ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED
)
RETURNING t.*
```

`ORDER BY "createdAt"` makes it FIFO. `runAfter <= now()` is how backoff works — a task waiting out
its backoff simply isn't claimable yet.

The limit is asserted from inside the worker. The test worker counts overlapping calls and keeps a
high-water mark, so the test proves three jobs never ran at once rather than proving a sampler never
caught them.

## Cancelling

`cancel` tries three guarded updates in order — from `queued`, from `running`, from `failed` — and
stops at the first that matches. Three rather than one because the follow-up differs and the code
needs to know which landed. A queued task has nothing to abort. A running one does. A failed one is
the dismiss path.

For a running task, the terminal state is written **before** the abort. The other order lets the
worker's promise reject, the error path run, and `failed` overwrite `cancelled` before the cancel
update lands.

If nothing matched, the task changed state between the read and the write, and `cancel` throws
rather than handing back a cancelled-looking task that's actually `ready`.

## Retries

If a worker reports a retryable failure and there's budget left, the task goes back to `queued` with
`runAfter` set to now plus a backoff that doubles per attempt, capped, plus up to 20% jitter so a
burst of retries doesn't re-synchronise.

A worker that throws instead of returning a failure told us nothing about whether the problem is
permanent, so it's assumed retryable and the attempt budget decides.

`retryable` describes the error, not the policy. When a retryable error runs out of attempts it
stays `retryable: true` and the reason is rewritten to say so: `worker failed after 3 attempts: …`.
Flipping it to false would tell an operator "this can never work" when the truth is "we stopped
trying", which is exactly when pressing retry is worth it.

A manual retry extends the budget rather than resetting `attempts`. `attempts` is a lifetime
counter, and a task that has burned nine attempts should not report one.

## Surviving a crash

**Write before act.** Every effect has its record written first. `claim` writes `running` and the
lease before the handler runs. `started` is written before the worker's first line. `transition`
commits before it publishes. The database is never behind reality. At worst it's ahead, describing
work a crash prevented, and ahead is recoverable.

**Runner identity.** Each process gets a fresh uuid at startup. Claimed rows are stamped with it and
settling transitions are guarded on it, so a process can only finish work it owns.

**Leases.** A claim sets `leaseUntil` 30s out. A heartbeat every 10s pushes it forward for
everything in flight. Three heartbeats fit in one lease, so a live process never loses its work,
and a dead one stops renewing.

**Recovery** happens two ways. The boot sweep runs once at startup and requeues every `running` row
this process doesn't own — on a single-runner deployment that can only be crash residue, so recovery
is immediate. The lease reaper runs on the heartbeat and picks up rows whose lease lapsed. Set
`bootSweep: false` if you run more than one process, or a booting one will requeue its peers' live
work.

**This is at-least-once.** A worker can finish its side effect and the process can die before the
status write commits. The row is still `running`, gets reclaimed, and runs again. Workers need to be
idempotent. Exactly-once would need the side effect and the status write in one transaction, which
isn't possible when the side effect is an HTTP call.

## Timeouts

`jobTimeoutMs` (5 minutes) is a liveness backstop, not a per-job SLA. It's there for a worker that
hangs and never checks its abort signal. Aborting such a worker does nothing, and the heartbeat keeps
renewing its lease, so the reaper won't rescue it either — the slot would be gone permanently, with
no error and no event.

The timer races the worker rather than aborting and awaiting it. Losing the race frees the slot
whether or not the worker ever unwinds. It does not stop the work: the abandoned worker keeps running
until it finishes on its own, so concurrency can briefly exceed the limit.

A timeout is recorded as an ordinary `failed` event with `detail.timedOut`, not a new event type.

## Events

The bus is two methods, `publish` and `subscribe`. It's narrow on purpose so a `LISTEN/NOTIFY`
version could drop in without the runner changing.

**Commit, then publish.** Publishing first lets a subscriber receive `ready`, immediately fetch the
task, and be told it's still `running`. Worse, if the transaction rolled back, they'd have been told
about a state that never existed.

Four event types are the contract: `accepted`, `ready`, `failed`, `cancelled`. Six more —
`started`, `retry_scheduled`, `requeued_on_restart`, `lease_expired`, `collected`, `retry_requested`
— are informational and clients can ignore them. The dashboard is why they exist.

Live events and replayed ones go through the same projection, so a client reconnecting with the last
id it saw gets something byte-identical to the live stream. Events are durable in `task_events`
regardless, so the bus is an optimisation over polling, never the source of truth.

## Workers

```ts
type Worker = (job: Job, ctx: WorkerContext) => Promise<WorkerResult>;
```

The `ctx` carries an `AbortSignal`. Without it, "a cancelled job actually stops" isn't possible —
the engine could mark the row `cancelled` while the worker burned its slot to completion.

Each worker declares its parameters, which drives validation at submit time and `lanes()`, so a UI
can render a submission form without hard-coding anything about a lane. Declared params are
validated and coerced; undeclared keys ride along untouched, since the `jsonb` column is there so
arbitrary caller metadata survives the round trip.

Three lanes ship. `scrape` and `report` are simulated — they sleep, and take a `fail` flag that
returns a retryable error, which makes the backoff schedule and the attempt budget easy to watch.
`web-scrape` does real work: it fetches a page and pulls out the title, description and link count.
It's the one that exercises real network failures, real cancellation, and the difference between a
404 and a 503.

Adding a lane is one entry in one array.

## Config

Only `workers` is required.

| Field | Default | |
|---|---|---|
| `workers` | *(required)* | The lanes this engine can run |
| `concurrency` | 4 | Jobs in flight at once |
| `pollIntervalMs` | 200 | Claim loop interval when idle; a freed slot also triggers a tick |
| `leaseMs` | 30000 | How long a claim stays owned |
| `heartbeatMs` | 10000 | Lease renewal interval, and the reaper's cadence |
| `maxAttempts` | 3 | Attempts before a task is declared failed |
| `backoffBaseMs` | 500 | First retry delay; doubles per attempt |
| `backoffMaxMs` | 30000 | Backoff ceiling, before jitter |
| `jobTimeoutMs` | 300000 | Liveness backstop |
| `bootSweep` | true | Requeue unowned `running` rows at startup. Turn off for multiple runners |
| `bus` | in-process | Where transitions are published |
| `logger` | silent | Where background failures go. A pino logger fits with no adapter |
| `runnerId` | random uuid | Identifies this process. A restart must produce a new one |

`createEngine()` never reads the environment. An engine that did couldn't be instantiated twice with
different settings in one process, which is what the durability tests need.

## Known limits

- **At-least-once, not exactly-once.** Covered above. Workers must be idempotent.
- **The boot sweep isn't multi-runner safe.** It's opt-out, not detected.
- **Concurrency is global and FIFO.** One user submitting two hundred jobs starves everyone behind
  them. Per-lane limits and a fairness key would both be small changes to `claim`.
- **A timeout frees the slot without stopping the work.** No fix inside a shared process. A
  thread-based lane could be killed outright.
- **Results go in `jsonb`.** Anything large belongs in object storage.
- **`task_events` grows forever.** No retention, no partitioning.
- **`stop({ drain: true })` leaves aborted rows `running` with a live lease.** They carry this
  runner's id, and the boot sweep skips rows it owns, so restarting the same instance leaves them to
  the reaper. Writing them back to `queued` during drain would remove the wait.
- **Advisory lock collisions serialise unrelated lanes.** Two `(user, lane)` pairs whose hashes
  collide queue behind each other. Costs throughput, never correctness, and is invisible when it
  happens.
- **The engine depends on the concrete `TaskRunner`**, not an interface. Every other dependency is
  one.
- **The default logger is silent.** Right for a library, but an engine nobody gave a logger to
  records nothing — a reclaimed lease, a subscriber that threw, a background loop that died, all
  invisible.

## Tests

40 tests under `tests/engine/`, all against a real Postgres. Nothing is mocked; the SQL is the logic
here, and a mocked repository would prove nothing about a partial unique index.

The scaffolding that makes them deterministic is a gate worker: it starts, records that it started,
and blocks until the test releases it. That turns "did the third job wait for a slot?" into a
question about an event the test caused, rather than a race against `setTimeout`.

```bash
docker compose up -d postgres && pnpm db:migrate
pnpm test:integration
```
