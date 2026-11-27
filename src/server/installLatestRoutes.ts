import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseInstallLatestPreview, parseInstallPair, type InstallPair } from "../shared/installLatest.js";
import type { NativeConfirm } from "./nativeConfirm.js";

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
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function run(script: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(script, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise(stdout);
        return;
      }
      const message = stderr.trim() || error.message;
      // A script that ran and said no (stale pair, lock held) is a conflict; one that could not start is unavailable.
      reject(new ScriptError(message, typeof error.code === "number" ? 409 : 503));
    });
  });
}

/** The native dialog's question: both short pairs and how many merges the owner's preview listed. */
export function installConfirmText(from: InstallPair, to: InstallPair, merges: number | undefined): string {
  const short = (sha: string) => sha.slice(0, 12);
  const count = merges === undefined ? "" : `\n\n${String(merges)} new merge${merges === 1 ? "" : "s"} since ${short(from.workbench)} + ${short(from.piWeb)}.`;
  return `Install Pi Workbench ${short(to.workbench)} + PI WEB ${short(to.piWeb)} and restart PI WEB?${count}\n\nThe restart interrupts every open session except Durable Chats.`;
}

/**
 * The request-source guard refuses foreign hosts and cross-site requests, but any same-user local process passes it,
 * so POST runs the install only after the owner clicks Allow in a native dialog (`confirm`; undefined off macOS: 501).
 */
export function registerInstallLatestRoutes(app: FastifyInstance, script: string | undefined, confirm: NativeConfirm | undefined): void {
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

  app.post<{ Body: { from?: unknown; to?: unknown; merges?: unknown } | undefined }>("/api/install/latest", async (request, reply) => {
    if (script === undefined) return reply.code(503).send(unavailable);
    if (confirm === undefined) return reply.code(501).send({ error: "Install latest needs a macOS confirmation dialog, which this platform lacks" });
    let from, to;
    try {
      from = parseInstallPair(request.body?.from);
      to = parseInstallPair(request.body?.to);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const merges = request.body?.merges;
    if (merges !== undefined && (typeof merges !== "number" || !Number.isSafeInteger(merges) || merges < 0))
      return reply.code(400).send({ error: "Expected merges to be a count" });
    // The count is display only and comes from the client; the pairs it names are what the script enforces.
    if (!(await confirm(installConfirmText(from, to, typeof merges === "number" ? merges : undefined)).catch(() => false)))
      return reply.code(403).send({ error: "not confirmed: the macOS dialog was not answered with Allow" });
    try {
      // Exactly the pairs the owner saw: the script refuses when another install happened (exit 8) or latest moved (exit 9).
      await run(script, ["latest", "--from", from.workbench, from.piWeb, "--to", to.workbench, to.piWeb], 600_000);
      return { status: "scheduled" };
    } catch (error) {
      return fail(error, reply);
    }
  });
}
