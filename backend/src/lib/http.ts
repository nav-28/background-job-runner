import { type Static, type TSchema, Type } from 'typebox';

/**
 * `{ id }` — returned by create endpoints.
 *
 * `title` on a response schema is what the frontend's client generator names its
 * type after, so always set one on anything that crosses the wire.
 */
export const idResponseSchema = Type.Object(
  {
    id: Type.String({
      format: 'uuid',
      example: '2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
      description: "Entity's id",
    }),
  },
  { title: 'IdResponse' },
);

/** Error body sent by src/plugins/error-handler.ts. Registered once as a shared schema. */
export const apiErrorResponseSchema = Type.Object(
  {
    statusCode: Type.Number({ example: 400 }),
    message: Type.String({ example: 'Validation Error' }),
    error: Type.String({ example: 'Bad Request' }),
    correlationId: Type.String({ example: 'YevPQs' }),
    subErrors: Type.Optional(
      Type.String({
        description: 'Optional list of sub-errors',
        example: 'incorrect email',
      }),
    ),
  },
  { $id: 'ApiErrorResponse' },
);

export type ApiErrorResponse = Static<typeof apiErrorResponseSchema>;

/** `?limit=&page=` — spread into a route's querystring schema. */
export const paginationQuerySchema = {
  limit: Type.Optional(
    Type.Number({
      example: 10,
      description: 'Specifies a limit of returned records',
      minimum: 1,
      maximum: 99_999,
    }),
  ),
  page: Type.Optional(
    Type.Number({
      example: 0,
      description: 'Page number',
      minimum: 0,
      maximum: 99_999,
    }),
  ),
};

/** Wraps an item schema in the standard `{ count, limit, page, data }` envelope. */
export function paginatedResponseSchema<T extends TSchema>(item: T, title: string) {
  return Type.Object(
    {
      count: Type.Number({ example: 5, description: 'Total number of items' }),
      limit: Type.Number({ example: 10, description: 'Number of items per page' }),
      page: Type.Number({ example: 0, description: 'Page number' }),
      data: Type.Array(item),
    },
    { title },
  );
}

export interface Paginated<T> {
  count: number;
  limit: number;
  page: number;
  data: T[];
}

const DEFAULT_LIMIT = 20;

/** Applies defaults and derives the SQL offset from a page number. */
export function paginationParams(
  { limit = DEFAULT_LIMIT, page = 0 } = {} as {
    limit?: number;
    page?: number;
  },
) {
  return { limit, page, offset: page * limit };
}
