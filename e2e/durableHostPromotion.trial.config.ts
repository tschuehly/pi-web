// Trial mode of durableHostPromotion.spec.ts: against a running trial instance, so no isolated PI WEB (see the spec).
import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

export default defineConfig({ ...base, testDir: ".", globalSetup: undefined, testMatch: "durableHostPromotion.spec.ts", outputDir: "../test-results/durable-promotion-trial" });
