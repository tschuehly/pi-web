import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Standalone examples consume the public entry, without requiring a prior build.
  resolve: {
    alias: { "@jmfederico/pi-web/server-plugin-api": fileURLToPath(new URL("./src/server-plugin-api.ts", import.meta.url)) },
  },
  test: {
    maxWorkers: 2,
    // Node 26 exposes a disabled localStorage accessor unless a backing file is provided.
    execArgv: [`--localstorage-file=${join(tmpdir(), `pi-web-vitest-${randomUUID()}.json`)}`],
    setupFiles: ["./src/test/localStorageIsolation.ts", "./src/test/happyDomShadowFocus.ts"],
    // Base CSS is application data exposed through the host UI styles capability;
    // mocking it to an empty string would bypass that contract in node tests.
    css: { include: [/\/theme\/base\/.*\.css/] },
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.ts", "pi-packages/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
