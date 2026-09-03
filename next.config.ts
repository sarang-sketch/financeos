import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    // A type error must fail the build; CI stage 1 gates hard.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
