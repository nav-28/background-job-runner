import { type Static, Type } from 'typebox';
import { paginatedResponseSchema, paginationQuerySchema } from '#src/lib/http.ts';
import type { User } from '#src/modules/user/user.types.ts';

/**
 * TypeBox schemas for the user routes. These are the single source of truth:
 * Fastify validates and serializes with them, @fastify/swagger turns them into
 * the OpenAPI document, and the frontend generates its typed client from that.
 *
 * `title` matters — the client generator names its types after it, so a missing
 * title produces junk like `FindUsers200DataItem`.
 */

/** POST /api/v1/users body */
export const createUserBodySchema = Type.Object(
  {
    email: Type.String({
      example: 'john@gmail.com',
      description: 'User email address',
      maxLength: 320,
      minLength: 5,
      format: 'email',
    }),
    name: Type.String({
      example: 'John Doe',
      description: 'Display name',
      maxLength: 100,
      minLength: 1,
    }),
  },
  { title: 'CreateUserRequest' },
);
export type CreateUserBody = Static<typeof createUserBodySchema>;

/** GET /api/v1/users querystring — pagination plus an optional email filter */
export const findUsersQuerySchema = Type.Object({
  ...paginationQuerySchema,
  email: Type.Optional(
    Type.String({
      example: 'john@gmail.com',
      description: 'Exact email address to filter on',
      maxLength: 320,
    }),
  ),
});
export type FindUsersQuery = Static<typeof findUsersQuerySchema>;

/** DELETE /api/v1/users/:id params */
export const userIdParamsSchema = Type.Object({
  id: Type.String({
    format: 'uuid',
    example: '2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
    description: "Entity's id",
  }),
});

/** A user on the wire. Dates are serialized as ISO strings. */
export const userResponseSchema = Type.Object(
  {
    id: Type.String({
      format: 'uuid',
      example: '2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
      description: "Entity's id",
    }),
    createdAt: Type.String({
      example: '2020-11-24T17:43:15.970Z',
      description: 'Entity creation date',
    }),
    updatedAt: Type.String({
      example: '2020-11-24T17:43:15.970Z',
      description: 'Entity last update date',
    }),
    email: Type.String({
      example: 'test@mail.com',
      format: 'email',
      description: "User's email address",
    }),
    name: Type.String({
      example: 'John Doe',
      description: "User's display name",
    }),
  },
  { title: 'UserResponse' },
);
export type UserResponse = Static<typeof userResponseSchema>;

export const userPaginatedResponseSchema = paginatedResponseSchema(
  userResponseSchema,
  'UserPaginatedResponse',
);

/**
 * Domain user -> wire shape. The only real difference is Date -> ISO string;
 * this keeps `Date` inside the app and out of the API contract.
 */
export function toUserResponse(user: User): UserResponse {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
