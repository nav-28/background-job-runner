import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { idResponseSchema } from '#src/lib/http.ts';
import {
  createUserBodySchema,
  findUsersQuerySchema,
  toUserResponse,
  userIdParamsSchema,
  userPaginatedResponseSchema,
} from '#src/modules/user/user.schema.ts';
import * as userService from '#src/modules/user/user.service.ts';

/**
 * HTTP layer for users. Routes validate, call a service, and shape the response —
 * no business logic and no SQL. Registered in src/app.ts under /api/v1.
 *
 * Every schema here feeds the OpenAPI document, which the frontend turns into a
 * typed client, so keep descriptions and examples meaningful.
 */
const userRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/users',
    {
      schema: {
        operationId: 'createUser',
        description: 'Create user',
        tags: ['users'],
        body: createUserBodySchema,
        response: { 201: idResponseSchema },
      },
    },
    async (req, res) => {
      const id = await userService.createUser(req.body);
      return res.status(201).send({ id });
    },
  );

  app.get(
    '/users',
    {
      schema: {
        operationId: 'findUsers',
        description: 'Find users',
        tags: ['users'],
        querystring: findUsersQuerySchema,
        response: { 200: userPaginatedResponseSchema },
      },
    },
    async (req, res) => {
      const result = await userService.findUsers(req.query);
      return res.status(200).send({ ...result, data: result.data.map(toUserResponse) });
    },
  );

  app.delete(
    '/users/:id',
    {
      schema: {
        operationId: 'deleteUser',
        description: 'Delete a user',
        tags: ['users'],
        params: userIdParamsSchema,
        response: { 204: { type: 'null', description: 'User Deleted' } },
      },
    },
    async (req, res) => {
      await userService.deleteUser(req.params.id);
      return res.status(204).send(null);
    },
  );
};

export default userRoutes;
