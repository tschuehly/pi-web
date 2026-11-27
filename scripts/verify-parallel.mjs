#!/usr/bin/env node
// Runs the independent verify checks at once; each line is prefixed with its check name, and a
// failed check's full output is repeated at the end so it is easy to find in a CI log.
import { spawn } from "node:child_process";

const checks = ["typecheck", "lint", "knip", "test"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const width = Math.max(...checks.map((c) => c.length));
const started = Date.now();

function run(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lines = [];
    const child = spawn(npm, ["run", "--silent", name], { env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" } });
    const prefix = `[${name.padEnd(width)}] `;
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.on("data", (chunk) => {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop();
        for (const line of parts) {
          lines.push(line);
          process.stdout.write(prefix + line + "\n");
        }
      });
      stream.on("end", () => {
        if (rest) {
          lines.push(rest);
          process.stdout.write(prefix + rest + "\n");
        }
      });
    }
    child.on("error", (error) => {
      lines.push(String(error));
      resolve({ name, code: 1, lines, seconds: 0 });
    });
    child.on("close", (code, signal) => resolve({ name, code: code ?? (signal ? 1 : 0), lines, seconds: (Date.now() - t0) / 1000 }));
  });
}

const results = await Promise.all(checks.map(run));
const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  process.stdout.write(`\n===== ${r.name} failed (exit ${r.code}) =====\n${r.lines.join("\n")}\n`);
}
process.stdout.write("\n");
for (const r of results) process.stdout.write(`${r.code === 0 ? "ok  " : "FAIL"} ${r.name.padEnd(width)} ${r.seconds.toFixed(1)}s\n`);
process.stdout.write(`verify: ${failed.length ? `${failed.length} failed` : "all passed"} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
process.exit(failed.length ? 1 : 0);
