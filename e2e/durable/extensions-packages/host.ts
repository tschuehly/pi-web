// Test-only host launcher: the real host, with fixture readings/transports and outbound TCP denied.
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const root = dirname(process.env["PI_CODING_AGENT_DIR"]!);
const options = JSON.parse(readFileSync(join(root, "host-options.json"), "utf8")) as { freeGb: number };
// Negative control disables the low-disk feature, not the mock validator or the assertion.
process.env["PI_STORAGE_GUARD_FREE_GB"] = process.env["FLEET_NEGATIVE_STORAGE"] === "1" ? "1000" : String(options.freeGb);
process.env["PING_A_HUMAN_PI_CONFIG"] = join(root, "phone-config.json");
process.env["PATH"] = `${join(root, "durable-agent/bin")}:${process.env["PATH"]}`;
for (const key of Object.keys(process.env)) if (/(?:API_KEY|TOKEN|PROXY)$/.test(key)) delete process.env[key];
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: Parameters<typeof original>) {
  const arg = args[0] as unknown;
  const address = typeof arg === "object" && arg !== null ? arg as { host?: string; path?: string } : undefined;
  const host = address?.host ?? (typeof args[1] === "string" ? args[1] : undefined);
  if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    appendFileSync(join(root, "network.jsonl"), `${JSON.stringify({ blocked: host })}\n`);
    throw new Error(`Fleet blocks non-fixture TCP: ${host}`);
  }
  return original.apply(this, args);
} as typeof original;
syncBuiltinESMExports();
await import(process.env["FLEET_REAL_HOST"]!);
