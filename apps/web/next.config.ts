import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mock-kabu/shared"],
  // Keep the browser bundle pinned to mock_kabu2's dedicated API even when a
  // parent shell has mock_kabu's NEXT_PUBLIC_API_URL in its environment.
  env: {
    NEXT_PUBLIC_API_URL: "http://localhost:4100",
  },
};

export default nextConfig;
