import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "*.spec.ts", globalSetup: "./setup.ts", workers: 1,
  timeout: 60_000, expect: { timeout: 10_000 },
  outputDir: process.env["FLEET_OUTPUT"] ?? "../../../test-results/extensions-packages",
  reporter: [["list"], ["json", { outputFile: process.env["FLEET_REPORT"] ?? "../../../test-results/extensions-packages.json" }]],
  use: { trace: "retain-on-failure" },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
