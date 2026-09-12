import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Ab S21: Nur Phase-6-Tests (UI)
    // Alte Tests (Phase 1-5) laufen nicht mehr automatisch
    include: ["ui/**/*.test.ts", "phase-6/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      "build",
      "context/**/*.test.ts",
      "runtime/**/*.test.ts",
      "gateway/**/*.test.ts",
      "heartbeat/**/*.test.ts",
      "policy/**/*.test.ts",
      "tools/**/*.test.ts",
      "skills/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
