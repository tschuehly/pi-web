// PI_WEB_E2E_DURABLE_HOST=<pinned chat-host-main.ts> npx playwright test -c e2e/durable/subagents-workers/playwright.config.ts --repeat-each=2
// Set TMPDIR below $PI_TMP. This config reuses isolatedPiWeb and adds only test-local host barriers/faults.
import { defineConfig } from "@playwright/test";
import base from "../../../playwright.config";

export default defineConfig(base, {
  testDir: ".",
  globalSetup: "./setup.ts",
  timeout: 60_000,
  use: { trace: "on" },
});
