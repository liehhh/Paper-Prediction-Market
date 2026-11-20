import { defineConfig } from "vitest/config";

// Opt-in checks against the REAL Polymarket API (`pnpm test:live`). Requires internet access.
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
