import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared contract package ships TypeScript source; let Next compile it.
  transpilePackages: ["@league/catalog-contract"],
  poweredByHeader: false,
};

export default nextConfig;
