import { type Static, Type } from 'typebox';
import { userResponseSchema } from '#src/modules/user/user.schema.ts';
import { AuthKind } from '#src/plugins/auth.ts';

/**
 * TypeBox schemas for the auth routes. They validate requests, serialize responses
 * and become the OpenAPI document the frontend generates its client from.
 */

const MIN_PASSWORD_LENGTH = 8;

const emailSchema = Type.String({
  example: 'john@gmail.com',
  description: 'Email address, used as the login identifier',
  format: 'email',
  minLength: 5,
  maxLength: 320,
});

const passwordSchema = Type.String({
  example: 'correct horse battery staple',
  description: 'Plaintext password. Sent once, stored only as a scrypt hash.',
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: 256,
});

/** POST /api/v1/auth/signup body */
export const signupBodySchema = Type.Object(
  {
    email: emailSchema,
    name: Type.String({
      example: 'John Doe',
      description: 'Display name',
      minLength: 1,
      maxLength: 100,
    }),
    password: passwordSchema,
  },
  { title: 'SignupRequest' },
);
export type SignupBody = Static<typeof signupBodySchema>;

/** POST /api/v1/auth/login body */
export const loginBodySchema = Type.Object(
  {
    email: emailSchema,
    password: passwordSchema,
  },
  { title: 'LoginRequest' },
);
export type LoginBody = Static<typeof loginBodySchema>;

/**
 * Signup and login both set the session cookie *and* return the token in the body.
 * The cookie is what a browser uses; the body is what `app.inject()` tests, curl and
 * non-browser clients use, so neither has to juggle a Set-Cookie header.
 */
export const sessionResponseSchema = Type.Object(
  {
    user: userResponseSchema,
    token: Type.String({
      example: '<header>.<payload>.<signature>',
      description: 'Session JWT. Also set as an HttpOnly cookie on this response.',
    }),
    expiresIn: Type.Number({
      example: 14_400,
      description: 'Token lifetime in seconds',
    }),
  },
  { title: 'SessionResponse' },
);

/** GET /api/v1/auth/me */
export const meResponseSchema = Type.Object(
  {
    user: userResponseSchema,
    kind: Type.Union([Type.Literal(AuthKind.session), Type.Literal(AuthKind.key)], {
      example: AuthKind.session,
      description: 'Which credential authenticated this request',
    }),
  },
  { title: 'MeResponse' },
);
