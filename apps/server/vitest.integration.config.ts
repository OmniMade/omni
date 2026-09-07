import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/integration/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
