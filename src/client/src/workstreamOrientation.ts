import { api, type MessagePage, type SessionRef } from "./api";
import type { WorkstreamSnapshot } from "./components/WorkstreamChooser";

const THREE_HOURS = 3 * 60 * 60 * 1000;

/** Eligibility only; the caller decides whether/how to reopen the Workstream. Call after session.confirmed. */
export async function shouldAutoOrientWorkstream(
  snapshot: Pick<WorkstreamSnapshot, "sessions">,
  newSessionId: string,
  machineId: string,
  client: Pick<typeof api, "locate" | "messages"> = api,
  now = Date.now(),
): Promise<boolean> {
  // Workstream snapshots order session IDs ascending; try newer Chats first to short-circuit on recent activity.
  const sessions = snapshot.sessions.filter((session) => session.id !== newSessionId && session.status === "active").reverse();
  if (sessions.length === 0 || !Number.isFinite(now)) return false;
  let latest = -Infinity;
  try {
    for (const session of sessions) {
      const sessionMachineId = session.machineId ?? machineId;
      const { cwd } = await client.locate(session.id, sessionMachineId);
      const ref: SessionRef = { id: session.id, cwd };
      let before: number | undefined;
      let found = false;
      for (;;) {
        const page: MessagePage = await client.messages(ref, { limit: 100, ...(before === undefined ? {} : { before }) }, sessionMachineId);
        for (let i = page.messages.length - 1; i >= 0; i--) {
          const message = page.messages[i];
          if (message === null || typeof message !== "object" || !("role" in message) || message.role !== "user") continue;
          // ponytail: user role is only a proxy for owner activity; injected/automated user-role messages can suppress auto-orientation. Use provenance when transcripts expose it.
          const timestamp = "timestamp" in message ? message.timestamp : undefined;
          const time = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" && timestamp.trim() !== "" ? Date.parse(timestamp) : NaN;
          if (!Number.isFinite(time) || time > now) return false; // An unknown newest user timestamp cannot establish a three-hour gap.
          if (now - time < THREE_HOURS) return false; // One recent linked Chat is enough; avoid opening the rest.
          latest = Math.max(latest, time);
          found = true;
          break;
        }
        if (found) break;
        if (!Number.isSafeInteger(page.start) || !Number.isSafeInteger(page.total) || page.start < 0 || page.total < 0 || page.start > page.total || (before !== undefined && page.start >= before)) return false;
        if (page.start === 0) break; // A confirmed but empty Chat adds no user timestamp.
        before = page.start;
      }
    }
  } catch {
    return false; // An unavailable session or unreadable history cannot establish recency.
  }
  return latest !== -Infinity && now - latest >= THREE_HOURS;
}
