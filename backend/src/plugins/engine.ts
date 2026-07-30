import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import env from '#src/config/env.ts';
import { createEngine } from '#src/engine/index.ts';
import type { Engine, EngineOptions, WorkerDescriptor } from '#src/engine/types.ts';
import { mockWorkers } from '#src/workers/mock-worker.ts';
import { createScrapeWorker } from '#src/workers/web-scrape/index.ts';

const workers: WorkerDescriptor[] = [...mockWorkers, createScrapeWorker()];

const AUTOSTART_BY_DEFAULT = !env.isTest;

export interface EnginePluginOptions {
  autostart?: boolean;
  config?: Omit<EngineOptions, 'workers'>;
}

async function enginePlugin(app: FastifyInstance, options: EnginePluginOptions) {
  const autostart = options.autostart ?? AUTOSTART_BY_DEFAULT;

  const engine = createEngine({
    ...env.engine,
    workers,
    logger: app.log,
    ...options.config,
  });

  app.decorate('engine', engine);

  if (autostart) {
    // Only start the app after the server is ready
    app.addHook('onReady', async () => {
      await engine.start();
      app.log.info(
        { concurrency: engine.config.concurrency, runnerId: engine.config.runnerId },
        'engine: claim loop started',
      );
    });
  }

  app.addHook('preClose', async () => {
    await engine.stop({ drain: true });
  });
}

export default fp(enginePlugin, { name: 'engine' });

declare module 'fastify' {
  interface FastifyInstance {
    engine: Engine;
  }
}
