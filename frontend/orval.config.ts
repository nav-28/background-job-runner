import { defineConfig } from 'orval';

/**
 * Generates a fully-typed TanStack Query client from the backend's OpenAPI spec.
 *
 *   pnpm generate:api        → generate from the committed ./openapi.json
 *   pnpm generate:api:live   → pull a fresh spec from the running backend, then generate
 *
 * `mode: 'tags-split'` emits one folder per OpenAPI tag with its own hooks + models,
 * so bundling only pulls in the endpoints a route actually imports (small bundles).
 */
export default defineConfig({
  api: {
    input: {
      // A URL also works here (e.g. http://127.0.0.1:3000/api-docs/json); the
      // `generate:api:live` script pulls that into ./openapi.json first.
      target: process.env.OPENAPI_INPUT ?? './openapi.json',
    },
    output: {
      mode: 'tags-split',
      client: 'react-query',
      target: './src/lib/api/endpoints',
      schemas: './src/lib/api/model',
      clean: true,
      biome: true,
      override: {
        mutator: {
          path: './src/lib/api/api-client.ts',
          name: 'customInstance',
        },
        query: {
          useQuery: true,
          signal: true,
        },
      },
    },
  },
});
