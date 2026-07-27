import { buildApp } from '#src/app.ts';
import env from '#src/config/env.ts';
import { closeDb } from '#src/db.ts';

const app = await buildApp();

app.addHook('onClose', async (instance) => {
  instance.log.info('Closing database connection…');
  await closeDb();
});

const shutDown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down gracefully…`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));

try {
  await app.listen({ port: env.server.port, host: env.server.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
