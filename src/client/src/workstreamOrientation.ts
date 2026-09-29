import { api, type MessagePage, type SessionRef } from "./api";
import type { WorkstreamSession, WorkstreamSnapshot } from "./components/WorkstreamChooser";

const THREE_HOURS = 3 * 60 * 60 * 1000;
type HistoryClient = Pick<typeof api, "locate" | "messages">;

/**
 * Orientation depth for a newly confirmed Workstream Chat: "brief" only when a linked Chat shows user input
 * within three hours; older, missing, or unreadable history needs "full". The caller decides whether to run it.
 */
export async function workstreamOrientationDepth(
  snapshot: Pick<WorkstreamSnapshot, "sessions">,
  newSessionId: string,
  machineId: string,
  client: HistoryClient = api,
  now = Date.now(),
): Promise<"brief" | "full"> {
  // Workstream snapshots order session IDs ascending; try newer Chats first to short-circuit on recent activity.
  const sessions = snapshot.sessions.filter((session) => session.id !== newSessionId && session.status === "active").reverse();
  for (const session of sessions) {
    try {
      if (await hasRecentUserInput(session, machineId, client, now)) return "brief";
    } catch { /* An unavailable session or unreadable history cannot establish recency. */ }
  }
  return "full";
}

async function hasRecentUserInput(session: WorkstreamSession, fallbackMachineId: string, client: HistoryClient, now: number): Promise<boolean> {
  const machineId = session.machineId ?? fallbackMachineId;
  const { cwd } = await client.locate(session.id, machineId);
  const ref: SessionRef = { id: session.id, cwd };
  let before: number | undefined;
  for (;;) {
    const page: MessagePage = await client.messages(ref, { limit: 100, ...(before === undefined ? {} : { before }) }, machineId);
    for (let i = page.messages.length - 1; i >= 0; i--) {
      const message = page.messages[i];
      if (message === null || typeof message !== "object" || !("role" in message) || message.role !== "user") continue;
      // ponytail: user role is only a proxy for owner activity; injected/automated user-role messages can shorten orientation. Use provenance when transcripts expose it.
      const timestamp = "timestamp" in message ? message.timestamp : undefined;
      const time = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" && timestamp.trim() !== "" ? Date.parse(timestamp) : NaN;
      // Only the newest user input counts; an unknown or future timestamp cannot establish recency.
      return Number.isFinite(time) && time <= now && now - time < THREE_HOURS;
    }
    if (!Number.isSafeInteger(page.start) || !Number.isSafeInteger(page.total) || page.start < 0 || page.start > page.total || (before !== undefined && page.start >= before)) return false;
    if (page.start === 0) return false; // A confirmed but empty Chat adds no user timestamp.
    before = page.start;
  }
}
