#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { effectivePiWebConfig, maxUploadBytes } from "../config.js";
import { buildApp } from "./app.js";

const clientDist = process.env["PI_WEB_CLIENT_DIST"];
if (clientDist !== undefined && (!isAbsolute(clientDist) || !existsSync(join(clientDist, "index.html")))) {
  throw new Error("PI_WEB_CLIENT_DIST must be an absolute directory containing index.html");
}
const { config } = effectivePiWebConfig();
const app = await buildApp({ bodyLimit: maxUploadBytes(process.env, config), ...(clientDist === undefined ? {} : { clientDist }) });
await app.listen({ port: config.port ?? 8504, host: config.host ?? "127.0.0.1" });
