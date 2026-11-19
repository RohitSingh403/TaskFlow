import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 40_000,
    hookTimeout: 40_000,
  },
});
