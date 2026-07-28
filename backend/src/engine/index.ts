import { randomUUID } from 'node:crypto';
import { InProcessEventBus } from '#src/engine/events.ts';
import { OrchestrationEngine } from '#src/engine/orchestration-engine.ts';
import { TaskRunner } from '#src/engine/runner.ts';
import type { Engine, EngineConfig, EngineLogger, EngineOptions } from '#src/engine/types.ts';
import { createWorkerRegistry } from '#src/engine/workers/registry.ts';

/**
 * The engine's front door. `Engine` in `types.ts` is the public surface; this file is the one
 * sanctioned way to build one, and nothing outside `src/engine/` imports any other file in here.
 */

export type { Engine, EngineLogger } from '#src/engine/types.ts';

const DEFAULTS = {
  concurrency: 4,
  pollIntervalMs: 200,
  leaseMs: 30_000,
  heartbeatMs: 10_000,
  maxAttempts: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  bootSweep: true,
  jobTimeoutMs: 300_000, // 5 mins — a liveness backstop, not a per-job SLA. See `EngineConfig`.
} as const;

const noop = (): void => undefined;

/**
 * The default sink. Silence is the right default for a library: an engine embedded in someone
 * else's process must not print to their stdout because they forgot to say otherwise. Production
 * passes `app.log`; the tests pass a capturing logger when they care and nothing when they do not.
 */
const SILENT_LOGGER: EngineLogger = { debug: noop, info: noop, warn: noop, error: noop };

/**
 * Resolves defaults, builds the registry, bus and runner, and hands them to an
 * `OrchestrationEngine`. All the wiring lives here so the engine class itself can take dependencies
 * that are already decided.
 *
 * `workers` has no default on purpose. Lanes are domain content: an engine that shipped with a
 * `scrape` lane baked in would know something about its consumers, and adding a worker would stop
 * being one entry in one array. The numeric knobs and the bus do default — they are implementation
 * detail with one obviously right answer.
 *
 * Config is passed in, never read from the environment. `src/config/env.ts` is deliberately not
 * imported: an engine that reads the process environment cannot be instantiated twice with
 * different settings, which is exactly what the durability tests need (two runners, different ids,
 * same database). Env wiring belongs in the Fastify plugin that will construct this later.
 */
export function createEngine(options: EngineOptions): Engine {
  // Resolved before the config literal because the default bus needs it: a subscriber that throws
  // is reported by the bus, and the bus has to be handed the same logger the runner uses.
  const logger = options.logger ?? SILENT_LOGGER;
  const config: EngineConfig = {
    ...DEFAULTS,
    runnerId: randomUUID(),
    ...options,
    logger,
    bus: options.bus ?? new InProcessEventBus(logger),
  };

  const registry = createWorkerRegistry(config.workers);
  const runner = new TaskRunner(config, registry);

  return new OrchestrationEngine(config, registry, runner, config.bus);
}
