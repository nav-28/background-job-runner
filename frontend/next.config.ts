import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Produce a minimal standalone server bundle for the Docker image.
  output: 'standalone',
  // The workspace root, not this package. pnpm symlinks frontend/node_modules into a store at the
  // repo root, and file tracing only follows links that land inside this root — without it the
  // standalone output ships dangling symlinks and the server dies on `require('react')`.
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  reactStrictMode: true,
  // MUI is tree-shakeable; this keeps icon/deep imports optimized.
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
};

export default nextConfig;
