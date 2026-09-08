import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mock-kabu/shared"],
  // NEXT_PUBLIC_* values are baked into the browser bundle at build time.
  // Keep the local default, while allowing the production image to point to
  // the HTTPS API origin injected by deploy/.env.production.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4100",
  },
};

export default nextConfig;
