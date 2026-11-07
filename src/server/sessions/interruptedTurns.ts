import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./sessionFileFormat.js";

/** One session that was mid-turn when the daemon shut down. */
export interface InterruptedTurn {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
}

/** Written by daemon shutdown, consumed once by the next daemon startup. */
export interface InterruptedTurnsRecord {
  shutdownAt: string;
  sessions: InterruptedTurn[];
}

export const DAEMON_RESTART_CUSTOM_TYPE = "pi-web.daemon-restart";

export async function writeInterruptedTurns(filePath: string, record: InterruptedTurnsRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid.toString()}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Read and delete the record. It is deleted before anything is resumed, so a
 * startup that crashes while resuming cannot resend the message forever.
 * A missing or malformed record yields nothing to resume.
 */
export async function takeInterruptedTurns(filePath: string): Promise<InterruptedTurnsRecord | undefined> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await rm(filePath, { force: true });
  }
  return parseInterruptedTurns(JSON.parse(source));
}

function parseInterruptedTurns(value: unknown): InterruptedTurnsRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { shutdownAt, sessions } = value;
  if (typeof shutdownAt !== "string" || !Array.isArray(sessions)) return undefined;
  return {
    shutdownAt,
    sessions: sessions.flatMap((entry: unknown) => {
      if (!isRecord(entry)) return [];
      const { sessionId, cwd, sessionFile } = entry;
      if (typeof sessionId !== "string" || typeof cwd !== "string") return [];
      return [{ sessionId, cwd, ...(typeof sessionFile === "string" ? { sessionFile } : {}) }];
    }),
  };
}

export function renderDaemonRestartMessage(shutdownAt: string): string {
  return `The PI WEB session daemon restarted at ${shutdownAt}; your previous turn was interrupted. `
    + "Check what had finished (files, background jobs, subagents) before continuing, then continue where you left off.";
}
