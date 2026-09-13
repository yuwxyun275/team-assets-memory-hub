import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// All source unit tests, with no credentials or external services required.
// Live integration tests use separate, explicitly invoked entry points.
export default mergeConfig(base, defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["**/*.e2e.test.ts"] },
}));
