import { defineConfig, devices } from "@playwright/test";

// End-to-end checks against an isolated PI WEB started by e2e/isolatedPiWeb.ts.
// WebKit matches the macOS app's WKWebView.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/isolatedPiWeb.ts",
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: "test-results/e2e",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
