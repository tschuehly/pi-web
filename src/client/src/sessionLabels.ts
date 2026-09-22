import type { SessionInfo } from "./api";

export function shortSessionId(id: string): string {
  return id.slice(-8);
}

export function sessionTitle(session: Pick<SessionInfo, "id" | "name" | "firstMessage">): string {
  if (session.name !== undefined && session.name !== "") return session.name;
  return session.firstMessage !== "" ? session.firstMessage : shortSessionId(session.id);
}
