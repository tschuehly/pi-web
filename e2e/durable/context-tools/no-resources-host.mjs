// Negative control for AC-P107: run the real pinned host but disable resource delivery at its IPC boundary.
// No product source changes and no mock-validation bypass. The normal resource acceptance assertions must fail.
import { pathToFileURL } from "node:url";
if (!process.env.DURABLE_FLEET_REAL_HOST) throw new Error("DURABLE_FLEET_REAL_HOST must name the real host entry");
process.prependListener("message", (message) => {
  if (message.method === "configure" && message.params) message.params.resources = {};
});
await import(pathToFileURL(process.env.DURABLE_FLEET_REAL_HOST).href);
