import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import env from '#src/config/env.ts';
import {
  loginBodySchema,
  meResponseSchema,
  sessionResponseSchema,
  signupBodySchema,
} from '#src/modules/auth/auth.schema.ts';
import * as authService from '#src/modules/auth/auth.service.ts';
import { toUserResponse } from '#src/modules/user/user.schema.ts';
import type { User } from '#src/modules/user/user.types.ts';
import {
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
  signSessionToken,
} from '#src/plugins/auth.ts';

/**
 * HTTP layer for authentication. Registered in src/app.ts under /api/v1.
 *
 * signup and login are public; /me opts in to either credential kind. Issuing the
 * session (signing the token, setting the cookie) lives here rather than in the
 * service because it is transport, not logic.
 */
const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const issueSession = (user: User) => {
    const token = signSessionToken(app, user.id);
    return {
      token,
      body: { user: toUserResponse(user), token, expiresIn: env.auth.sessionTtlSeconds },
    };
  };

  app.post(
    '/auth/signup',
    {
      schema: {
        operationId: 'signup',
        description: 'Create an account and start a session',
        tags: ['auth'],
        body: signupBodySchema,
        response: { 201: sessionResponseSchema, 409: { $ref: 'ApiErrorResponse#' } },
      },
    },
    async (req, res) => {
      const user = await authService.signup(req.body);
      const { token, body } = issueSession(user);
      setSessionCookie(res, token);
      return res.status(201).send(body);
    },
  );

  app.post(
    '/auth/login',
    {
      schema: {
        operationId: 'login',
        description: 'Exchange email and password for a session',
        tags: ['auth'],
        body: loginBodySchema,
        response: { 200: sessionResponseSchema, 401: { $ref: 'ApiErrorResponse#' } },
      },
    },
    async (req, res) => {
      const user = await authService.login(req.body.email, req.body.password);
      const { token, body } = issueSession(user);
      setSessionCookie(res, token);
      return res.status(200).send(body);
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        operationId: 'logout',
        description: 'Clear the session cookie',
        tags: ['auth'],
        response: { 204: { type: 'null', description: 'Session Cleared' } },
      },
    },
    async (_req, res) => {
      // Deliberately public and unconditional: logging out must work even when the
      // cookie the caller holds is already expired or invalid.
      clearSessionCookie(res);
      return res.status(204).send(null);
    },
  );

  app.get(
    '/auth/me',
    {
      config: { auth: true },
      schema: {
        operationId: 'me',
        description: 'The authenticated user and the credential that identified them',
        tags: ['auth'],
        response: { 200: meResponseSchema, 401: { $ref: 'ApiErrorResponse#' } },
      },
    },
    async (req, res) => {
      const { userId, kind } = requireAuth(req);
      const user = await authService.currentUser(userId);
      return res.status(200).send({ user: toUserResponse(user), kind });
    },
  );
};

export default authRoutes;
