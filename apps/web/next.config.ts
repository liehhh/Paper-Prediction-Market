import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared contract packages ship TypeScript source; let Next compile them.
  transpilePackages: ["@league/catalog-contract", "@league/trading-contract"],
  poweredByHeader: false,
};

export default nextConfig;
