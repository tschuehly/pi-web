import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { PiSessionService } from "./sessions/piSessionService.js";

/** Only called by an explicitly opted-in, separately launched fixture daemon. */
export async function openControlledPendingAskFixture(sessions: Pick<PiSessionService, "status" | "openAsk">, env: NodeJS.ProcessEnv): Promise<void> {
  const ref = await validateControlledPendingAskFixture(env);
  // Open the persisted session in this daemon first; status and ask mutations
  // then share the same runtime and the service's daemon-memory ask store.
  const status = await sessions.status(ref);
  if (status.sessionId !== ref.id) throw new Error("Controlled fixture session identity mismatch");
  await sessions.openAsk({ sessionId: ref.id, questions: [{ id: "fixture-choice", question: "Which controlled fixture answer?", options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }] }] });
}

export async function validateControlledPendingAskFixture(env: NodeJS.ProcessEnv): Promise<{ id: string; cwd: string }> {
  const root = env["PI_WEB_FIXTURE_OWNED_ROOT"];
  const manifest = env["PI_WEB_FIXTURE_PENDING_ASK_MANIFEST"];
  const sessionDir = env["PI_CODING_AGENT_SESSION_DIR"];
  const agentDir = env["PI_CODING_AGENT_DIR"];
  const dataDir = env["PI_WEB_DATA_DIR"];
  const socket = env["PI_WEB_SESSIOND_SOCKET"];
  if (root === undefined || manifest === undefined || sessionDir === undefined || agentDir === undefined || dataDir === undefined || socket === undefined
    || ![root, manifest, sessionDir, agentDir, dataDir, socket].every(isAbsolute)) {
    throw new Error("Pending ask fixture requires absolute owned root, manifest, agent dir, session dir, data dir, and daemon socket paths");
  }
  const ownedRoot = await realpath(root);
  if (ownedRoot === "/") throw new Error("Pending ask fixture requires a non-root owned directory");
  for (const [name, path] of [["manifest", manifest], ["agent dir", agentDir], ["session dir", sessionDir], ["data dir", dataDir], ["daemon socket", socket]] as const) {
    const target = name === "daemon socket" ? join(await realpath(dirname(path)), "sessiond.sock") : await realpath(path);
    const rel = relative(ownedRoot, target);
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`Pending ask fixture ${name} must be strictly inside its owned root`);
  }
  if (socket !== join(dirname(socket), "sessiond.sock")) throw new Error("Pending ask fixture requires its own sessiond.sock");
  const parsed: unknown = JSON.parse(await readFile(manifest, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("anchors" in parsed) || !Array.isArray(parsed.anchors)) throw new Error("Invalid controlled fixture manifest");
  const anchor: unknown = parsed.anchors[0];
  if (typeof anchor !== "object" || anchor === null || !("sessionId" in anchor) || !("cwd" in anchor)
    || typeof anchor.sessionId !== "string" || typeof anchor.cwd !== "string") throw new Error("Missing controlled fixture anchor");
  if (anchor.sessionId !== "019c8f10-1000-7000-8000-000000000001") throw new Error("Unexpected controlled fixture session identity");
  const cwd = await realpath(anchor.cwd);
  const rel = relative(ownedRoot, cwd);
  if (rel !== join("workspaces", "anchor-1")) throw new Error("Pending ask fixture workspace must be the first owned anchor");
  return { id: anchor.sessionId, cwd };
}
