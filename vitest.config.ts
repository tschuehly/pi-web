import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node 26 exposes a disabled localStorage accessor unless a backing file is
    // provided. Happy DOM cannot replace that accessor in worker processes.
    execArgv: [`--localstorage-file=${join(tmpdir(), `pi-web-vitest-${randomUUID()}.json`)}`],
    include: ["src/**/*.test.ts", "pi-web-plugins/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
