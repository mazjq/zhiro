import { defineConfig } from "vitest/config";
// CI machines (Windows especially) are several times slower than a laptop: the 5 s default is for local runs only
export default defineConfig({ test: { include: ["src/**/*.test.ts"], globalSetup: ["src/test-tmp.ts"], testTimeout: process.env.CI ? 60_000 : 5_000, hookTimeout: process.env.CI ? 60_000 : 10_000 } });
