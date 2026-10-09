import type { NextConfig } from "next";
import path from "node:path";

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  transpilePackages: ['@synapse/auth', '@synapse/db', '@synapse/config', '@synapse/email', '@synapse/ui', '@synapse/interop'],
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, "../.."),
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'synapseos.tech' },
      { protocol: 'https', hostname: '*.synapseos.tech' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
