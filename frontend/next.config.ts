import type { NextConfig } from 'next';

/**
 * The backend origin used by the dev/prod proxy rewrite below.
 * - Local dev:            defaults to http://localhost:3000
 * - Docker compose:       set BACKEND_URL=http://backend:3000
 * This is a server-side env var (not exposed to the browser).
 *
 * IMPORTANT: `rewrites()` is evaluated during `next build` and baked into
 * .next/routes-manifest.json. For a built image, BACKEND_URL must therefore be
 * present at BUILD time (see the ARG in frontend/Dockerfile) — setting it only
 * at runtime silently leaves the proxy pointing at localhost.
 */
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';

const nextConfig: NextConfig = {
  // Produce a minimal standalone server bundle for the Docker image.
  output: 'standalone',
  reactStrictMode: true,
  // MUI is tree-shakeable; this keeps icon/deep imports optimized.
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
  /**
   * Proxy API calls to the Fastify backend so the browser always talks to the
   * frontend origin (no CORS in the common case). The generated client calls
   * relative `/api/...` paths, which Next.js rewrites to the backend here.
   */
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
