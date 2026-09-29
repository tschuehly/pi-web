import { api, type SessionRef } from "./api";
import type { WorkstreamSnapshot } from "./components/WorkstreamChooser";

type CommandClient = Pick<typeof api, "runCommand">;

/**
 * Ask the session's server to rename a Chat to its newest Workstream checkpoint's sessionTitle.
 * The server keeps names the owner set; `attempted` stops re-sending a title it declined.
 */
export async function applyCheckpointSessionTitle(
  snapshot: Pick<WorkstreamSnapshot, "sessions">,
  session: SessionRef & { name?: string | undefined },
  machineId: string,
  attempted: Set<string>,
  client: CommandClient = api,
): Promise<void> {
  const title = snapshot.sessions.find((candidate) => candidate.id === session.id)?.latestCheckpoint?.sessionTitle?.trim();
  if (title === undefined || title === "" || title === session.name) return;
  const key = `${machineId}\n${session.id}\n${title}`;
  if (attempted.has(key)) return;
  attempted.add(key);
  await client.runCommand({ id: session.id, cwd: session.cwd }, `/workstream-checkpoint-title ${title}`, machineId);
}
