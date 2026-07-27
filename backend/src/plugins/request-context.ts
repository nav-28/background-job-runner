import { fastifyRequestContext, requestContext } from '@fastify/request-context';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

declare module '@fastify/request-context' {
  interface RequestContextData {
    requestId: string;
  }
}

/**
 * Stores the Fastify request id in AsyncLocalStorage so any code in the call
 * stack can read it without threading it through every function signature.
 */
async function requestContextPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyRequestContext);
  fastify.addHook('onRequest', async (req) => {
    requestContext.set('requestId', req.id);
  });
}

/** Current request id, or a sentinel when called outside a request (e.g. at boot). */
export function getRequestId(): string {
  return requestContext.get('requestId') ?? 'no-request-context';
}

export default fp(requestContextPlugin, { name: 'requestContext' });
