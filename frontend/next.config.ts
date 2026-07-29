import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Produce a minimal standalone server bundle for the Docker image.
  output: 'standalone',
  reactStrictMode: true,
  // MUI is tree-shakeable; this keeps icon/deep imports optimized.
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
};

export default nextConfig;
