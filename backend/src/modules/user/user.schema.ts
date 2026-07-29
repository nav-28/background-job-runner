import { type Static, Type } from 'typebox';
import type { User } from '#src/modules/user/user.types.ts';

/**
 * TypeBox schemas for the user shape on the wire. These are the single source of
 * truth: Fastify validates and serializes with them, @fastify/swagger turns them
 * into the OpenAPI document, and the frontend generates its typed client from that.
 *
 * `title` matters — the client generator names its types after it, so a missing
 * title produces junk like `FindUsers200DataItem`.
 *
 * There are no user request schemas here any more: the user routes were retired in
 * favour of the auth module, which owns every endpoint that touches a user.
 */

/** A user on the wire. Dates are serialized as ISO strings; the password hash never is. */
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

/**
 * Domain user -> wire shape. Fields are listed explicitly rather than spread, so a
 * new column (`passwordHash` was the first) cannot leak into a response by default.
 */
export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
