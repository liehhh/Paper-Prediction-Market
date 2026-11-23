import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared contract packages ship TypeScript source; let Next compile them.
  transpilePackages: ["@league/catalog-contract", "@league/trading-contract"],
  poweredByHeader: false,
  // The shared map used to live at /league. It is called the World now; old links and bookmarks keep working.
  async redirects() {
    return [
      { source: "/league", destination: "/world", permanent: true },
      { source: "/api/league", destination: "/api/world", permanent: true },
    ];
  },
};

export default nextConfig;
