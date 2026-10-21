#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { networkInterfaces } from "node:os";
import { effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";
import { startupUrlLines } from "./startupUrls.js";
import { startupLogger } from "./startupLogger.js";

const clientDist = process.env["PI_WEB_CLIENT_DIST"];
if (clientDist !== undefined && (!isAbsolute(clientDist) || !existsSync(join(clientDist, "index.html")))) {
  throw new Error("PI_WEB_CLIENT_DIST must be an absolute directory containing index.html");
}
const { config } = effectivePiWebConfig();
const app = await buildApp({
  bodyLimit: maxUploadBytes(process.env, config),
  logger: startupLogger,
  requestSource: { ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }), ...(config.host === undefined ? {} : { host: config.host }) },
  ...(clientDist === undefined ? {} : { clientDist }),
});
await app.listen({ port: config.port ?? 8504, host: config.host ?? "127.0.0.1" });
const bound = app.server.address();
if (bound === null || typeof bound === "string") throw new Error("Expected a bound TCP address after listen");
console.log(`\n  PI WEB is ready\n\n${startupUrlLines(bound, networkInterfaces()).join("\n")}\n`);
