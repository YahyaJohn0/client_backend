import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    minWorkers: 1,
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});
