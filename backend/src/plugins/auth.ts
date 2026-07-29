import type { CookieSerializeOptions } from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import { requestContext } from '@fastify/request-context';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import env from '#src/config/env.ts';
import { ForbiddenError, UnauthorizedError } from '#src/lib/errors.ts';
import { API_KEY_PREFIX, verifyApiKey } from '#src/modules/apikey/apikey.service.ts';

/**
 * Authentication for the HTTP layer.
 *
 * Two credential kinds resolve to the same `userId`:
 *   - humans  -> a short-lived JWT in an HttpOnly cookie, issued by /auth/login
 *   - machines -> a long-lived, revocable API key sent as `Authorization: Bearer jrk_…`
 *
 * Auth is opt-in per route via `config.auth`, resolved in one global onRequest hook.
 * A route that declares nothing pays nothing: the hook returns on its first line.
 *
 *   app.get('/thing', { config: { auth: true } }, handler)                     // either kind
 *   app.post('/keys', { config: { auth: { session: true, apiKey: false } } })  // humans only
 */

export const AuthKind = {
  session: 'session',
  key: 'key',
} as const;
export type AuthKind = (typeof AuthKind)[keyof typeof AuthKind];

/** Who is making this request, and with what. */
export interface AuthContext {
  userId: string;
  kind: AuthKind;
  /** Set only for `kind: 'key'` — the api_keys row that authenticated the request. */
  keyId?: string;
}

/** What a route may declare. `true` accepts either kind; the object form restricts. */
export type AuthRouteConfig = boolean | { session?: boolean; apiKey?: boolean };

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthRouteConfig;
  }
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export const SESSION_COOKIE = 'auth_session';

const BEARER_SCHEME = 'bearer ';

function sessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: env.auth.sessionTtlSeconds,
  };
}

/** Signs a session token for a user. TTL comes from the plugin's sign options. */
export function signSessionToken(app: FastifyInstance, userId: string): string {
  return app.jwt.sign({ sub: userId });
}

export function setSessionCookie(res: FastifyReply, token: string): void {
  res.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
}

/** Attributes must match the ones it was set with, or the browser keeps the cookie. */
export function clearSessionCookie(res: FastifyReply): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
}

/**
 * Reads the auth context a route required. Routes call this instead of touching
 * `request.authContext`, so handlers get a non-optional value with no `!`.
 */
export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.authContext) {
    throw new UnauthorizedError('Authentication required');
  }
  return req.authContext;
}

/** The token from `Authorization: Bearer …`, or null. The scheme is case-insensitive. */
function readBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.toLowerCase().startsWith(BEARER_SCHEME)) {
    return null;
  }

  const token = header.slice(BEARER_SCHEME.length).trim();
  return token.length > 0 ? token : null;
}

/** Invalid, expired and unparseable tokens are all just "no identity". */
function verifySessionToken(app: FastifyInstance, token: string): AuthContext | null {
  try {
    const payload = app.jwt.verify<{ sub?: unknown }>(token);
    return typeof payload.sub === 'string' && payload.sub.length > 0
      ? { userId: payload.sub, kind: AuthKind.session }
      : null;
  } catch {
    return null;
  }
}

async function verifyApiKeyToken(token: string): Promise<AuthContext | null> {
  const identity = await verifyApiKey(token);
  return identity ? { userId: identity.userId, kind: AuthKind.key, keyId: identity.keyId } : null;
}

/**
 * Bearer header first, session cookie second.
 *
 * A bearer token is treated as an API key when it carries the key prefix, and as a
 * JWT otherwise. Discriminating on the prefix rather than sniffing for JWT dots is
 * explicit, and it is what makes keys greppable by secret scanners.
 */
async function resolveCredential(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<AuthContext | null> {
  const bearer = readBearerToken(req);
  if (bearer) {
    return bearer.startsWith(API_KEY_PREFIX)
      ? verifyApiKeyToken(bearer)
      : verifySessionToken(app, bearer);
  }

  const cookie = req.cookies[SESSION_COOKIE];
  return cookie ? verifySessionToken(app, cookie) : null;
}

/**
 * Fail-closed: in the object form a kind is allowed only when it is explicitly
 * `true`, so `{ session: true }` is session-only rather than silently open.
 */
function isKindAllowed(config: AuthRouteConfig, kind: AuthKind): boolean {
  if (config === true) {
    return true;
  }
  if (config === false) {
    return false;
  }
  return kind === AuthKind.session ? config.session === true : config.apiKey === true;
}

async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(fastifyJwt, {
    secret: env.auth.jwtSecret,
    sign: { expiresIn: env.auth.sessionTtlSeconds },
    // @fastify/jwt also decorates `request.user`, populated by request.jwtVerify().
    // Nothing here calls that — the hook below branches on the token prefix itself
    // and puts the result on `request.authContext`. Don't build on `request.user`.
  });

  // Fastify wants a declared shape on the prototype rather than a property added
  // per request; `undefined` keeps the hidden class stable.
  fastify.decorateRequest('authContext', undefined);

  fastify.addHook('onRequest', async (req) => {
    const routeAuth = req.routeOptions.config.auth;
    if (!routeAuth) {
      return;
    }

    const context = await resolveCredential(fastify, req);
    if (!context) {
      // One message for "nothing supplied" and "supplied but invalid/expired/revoked" —
      // the distinction tells an attacker something and tells a client nothing.
      throw new UnauthorizedError('Authentication required');
    }

    if (!isKindAllowed(routeAuth, context.kind)) {
      throw new ForbiddenError(`This endpoint does not accept ${context.kind} credentials`);
    }

    req.authContext = context;
    // Alongside requestId, so every log line for this request carries the caller.
    requestContext.set('userId', context.userId);
  });
}

export default fp(authPlugin, { name: 'auth', dependencies: ['requestContext'] });
