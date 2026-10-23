import { defineConfig, devices } from "@playwright/test";

// End-to-end checks against an isolated PI WEB started by e2e/isolatedPiWeb.ts.
// WebKit matches the macOS app's WKWebView.
export default defineConfig({
  testDir: "e2e",
  // Fleet acceptance areas (e2e/durable/<area>/) keep deferred ACs as ordinary failures and need their own setup, so the
  // default suite skips them. Run one with PI_WEB_E2E_FLEET=1 and its config or run.sh (see each area's header).
  testIgnore: process.env["PI_WEB_E2E_FLEET"] === "1" ? [] : ["**/e2e/durable/*/**"],
  globalSetup: "./e2e/isolatedPiWeb.ts",
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: "test-results/e2e",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
