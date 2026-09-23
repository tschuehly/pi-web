import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkstreamLaunchRecord =
  | { token: string; cwd: string; status: "pending" }
  | { token: string; cwd: string; status: "created"; sessionId: string };

export function isWorkstreamLaunchToken(token: string): boolean {
  return token.startsWith("pi-web:") || token.startsWith("workbench-web:") || token.startsWith("launch-");
}

function checkToken(token: string): void {
  if (!isWorkstreamLaunchToken(token) || token.length > 128 || !/^[a-zA-Z0-9:._-]+$/.test(token)) {
    throw new Error("Invalid Workstream launch token");
  }
}

/** Daemon-owned exact launch evidence, separate from Pi's delayed transcript save. */
export class WorkstreamLaunchStore {
  constructor(private readonly directory: string) {}

  private path(token: string): string {
    checkToken(token);
    return join(this.directory, `${createHash("sha256").update(token).digest("hex")}.json`);
  }

  async reserve(token: string, cwd: string): Promise<void> {
    const path = this.path(token);
    if (!cwd) throw new Error("Workstream launch cwd is required");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, JSON.stringify({ token, cwd, status: "pending" }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) throw new Error("Workstream launch token is already reserved; look it up instead", { cause: error });
      throw error;
    }
  }

  async confirm(token: string, cwd: string, sessionId: string): Promise<void> {
    const current = await this.lookup(token);
    if (current?.cwd !== cwd) throw new Error("Workstream launch location changed or reservation is missing");
    if (current.status === "created") {
      if (current.sessionId !== sessionId) throw new Error("Workstream launch token is already bound to another session");
      return;
    }
    if (!sessionId) throw new Error("Workstream launch session id is required");
    const path = this.path(token);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify({ token, cwd, sessionId, status: "created" }), { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch((error: unknown) => { if (!isNodeError(error, "ENOENT")) throw error; });
    }
  }

  async lookup(token: string): Promise<WorkstreamLaunchRecord | undefined> {
    const path = this.path(token);
    let content: string;
    try { content = await readFile(path, "utf8"); }
    catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
    if (content.length > 4096) throw new Error("Invalid Workstream launch record");
    let value: unknown;
    try { value = JSON.parse(content); } catch { throw new Error("Invalid Workstream launch record"); }
    if (typeof value !== "object" || value === null || !("token" in value) || value.token !== token || !("cwd" in value) || typeof value.cwd !== "string" || value.cwd === "" || !("status" in value)) throw new Error("Invalid Workstream launch record");
    if (value.status === "pending") return { token, cwd: value.cwd, status: "pending" };
    if (value.status === "created" && "sessionId" in value && typeof value.sessionId === "string" && value.sessionId !== "") return { token, cwd: value.cwd, sessionId: value.sessionId, status: "created" };
    throw new Error("Invalid Workstream launch record");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
