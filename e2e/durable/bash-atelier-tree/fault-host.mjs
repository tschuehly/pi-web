// Test-only entry wrapper. DURABLE_FLEET_HOST is the pinned real chat-host-main.ts entry.
// A one-shot file inside this Chat's isolated store arms existing product crash points.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const store = process.argv[process.argv.indexOf("--store") + 1];
const fault = join(store, "fleet-crash");
if (existsSync(fault)) {
  process.env.PI_DURABLE_CRASH_AT = readFileSync(fault, "utf8");
  if (process.env.PI_DURABLE_CRASH_AT === "atelier.check-enabled") delete process.env.ATELIER_PAGE_CHECK;
  unlinkSync(fault);
}
// Negative control: emulate a broken host that ignores the client's expected history revision.
if (process.env.DURABLE_FLEET_NEGATIVE_CONTROL === "1") {
  const on = process.on.bind(process);
  process.on = (event, listener) => on(event, event !== "message" ? listener : (request) => {
    const current = join(store, "fleet-current-leaf");
    if (request?.method === "navigate" && existsSync(current)) request.params.expectedLeafId = JSON.parse(readFileSync(current, "utf8"));
    listener(request);
  });
}
if (!process.env.DURABLE_FLEET_HOST) throw new Error("DURABLE_FLEET_HOST must name the real pinned host");
await import(pathToFileURL(process.env.DURABLE_FLEET_HOST).href);
