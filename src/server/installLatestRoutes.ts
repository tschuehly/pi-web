import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseInstallLatestPreview, parseInstallPair } from "../shared/installLatest.js";

/**
 * pi-workbench `scripts/promote-installed` of the installed checkout: PI_WEB_PROMOTE_INSTALLED, else beside the Durable
 * host entry PI_WEB_DURABLE_HOST (`<checkout>/packages/durable-pilot/src/chat-host-main.ts`). Undefined outside Durable.
 */
export function promoteInstalledScript(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env["PI_WEB_PROMOTE_INSTALLED"];
  if (override !== undefined && override !== "") return override;
  const host = env["PI_WEB_DURABLE_HOST"];
  return host === undefined || host === "" ? undefined : join(resolve(dirname(host), "../../.."), "scripts", "promote-installed");
}

class ScriptError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

function run(script: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(script, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) { resolvePromise(stdout); return; }
      const message = stderr.trim() || error.message;
      // A script that ran and said no (stale pair, lock held) is a conflict; one that could not start is unavailable.
      reject(new ScriptError(message, typeof error.code === "number" ? 409 : 503));
    });
  });
}

/** Owner-only like every route: the request-source guard refuses foreign hosts and cross-site requests. */
export function registerInstallLatestRoutes(app: FastifyInstance, script: string | undefined): void {
  const unavailable = { error: "Install latest needs the Durable PI WEB install (PI_WEB_DURABLE_HOST is not set)" };
  const fail = (error: unknown, reply: FastifyReply) =>
    reply.code(error instanceof ScriptError ? error.statusCode : 502).send({ error: error instanceof Error ? error.message : String(error) });

  app.get("/api/install/latest", async (_request, reply) => {
    if (script === undefined) return reply.code(503).send(unavailable);
    try {
      const stdout = await run(script, ["latest", "--dry-run", "--json"], 120_000);
      return parseInstallLatestPreview(JSON.parse(stdout));
    } catch (error) {
      return fail(error, reply);
    }
  });

  app.post<{ Body: { from?: unknown } | undefined }>("/api/install/latest", async (request, reply) => {
    if (script === undefined) return reply.code(503).send(unavailable);
    let from;
    try {
      from = parseInstallPair(request.body?.from);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    try {
      // Exactly the pair the owner saw, so the script refuses when either branch moved since.
      await run(script, ["latest", "--from", from.workbench, from.piWeb], 600_000);
      return { status: "scheduled" };
    } catch (error) {
      return fail(error, reply);
    }
  });
}
