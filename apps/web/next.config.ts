import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  experimental: {
    serverActions: {
      allowedOrigins: ["*.synapseos.tech", "localhost:3001", "127.0.0.1:3001"],
    },
  },
  transpilePackages: [
    "@synapse/auth",
    "@synapse/db",
    "@synapse/config",
    "@synapse/email",
    "@synapse/ui",
    "@synapse/interop",
  ],
  // ESLint flat-config + monorepo ajv hoist can trip `defaultMeta` during CI;
  // type-check still runs in verify scripts / local tsc.
  eslint: {
    ignoreDuringBuilds: true,
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
    ],
  },
  async redirects() {
    return [
      { source: "/doctor/ai", destination: "/doctor", permanent: false },
      { source: "/doctor/consults", destination: "/doctor", permanent: false },
      { source: "/doctor/notes", destination: "/doctor", permanent: false },
      { source: "/doctor/referrals", destination: "/referrals", permanent: false },
      { source: "/doctor/reports", destination: "/doctor", permanent: false },
      { source: "/doctor/rounds", destination: "/doctor", permanent: false },
      { source: "/doctor/schedule", destination: "/doctor", permanent: false },
      { source: "/doctor/tele", destination: "/doctor", permanent: false },
      { source: "/nurse/beds", destination: "/nurse", permanent: false },
      { source: "/nurse/handover", destination: "/nurse", permanent: false },
      { source: "/nurse/mar", destination: "/nurse", permanent: false },
      { source: "/nurse/observations", destination: "/nurse", permanent: false },
      { source: "/nurse/procedures", destination: "/nurse", permanent: false },
      { source: "/consults", destination: "/doctor", permanent: false },
      { source: "/consults/new", destination: "/doctor", permanent: false },
      { source: "/consults/:id", destination: "/doctor", permanent: false },
      { source: "/consults/:id/call", destination: "/doctor", permanent: false },
      { source: "/lab/reports", destination: "/lab/results", permanent: false },
      { source: "/lab/qc", destination: "/lab/verify", permanent: false },
      { source: "/admin/lab", destination: "/lab/orders", permanent: false },
      { source: "/admin/supply/orders", destination: "/admin/supply", permanent: false },
      { source: "/admin/settings/branding", destination: "/hospital/admin/settings", permanent: false },
      { source: "/admin/settings/domain", destination: "/hospital/admin/settings", permanent: false },
      { source: "/admin/settings/guidelines", destination: "/hospital/admin/settings", permanent: false },
      { source: "/referrals/incoming", destination: "/referrals", permanent: false },
      { source: "/referrals/outgoing", destination: "/referrals", permanent: false },
      { source: "/os/:slug/clinical", destination: "/os/:slug/clinical/queue", permanent: false },
      { source: "/encounter/:id/scoring", destination: "/encounter/:id", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Robots-Tag", value: "noai, noimageai" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
