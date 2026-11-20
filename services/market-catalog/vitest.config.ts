import { defineConfig } from "vitest/config";

// Deterministic tests: fixtures, fake HTTP, and a throwaway local PostgreSQL. No network.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
