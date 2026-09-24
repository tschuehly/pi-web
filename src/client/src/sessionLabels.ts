import type { SessionInfo } from "./api";

export function shortSessionId(id: string): string {
  return id.slice(-8);
}

export function sessionTitle(session: Pick<SessionInfo, "id" | "name" | "firstMessage">): string {
  const name = session.name?.trim();
  if (name !== undefined && name !== "") return name;
  const firstMessage = session.firstMessage.trim();
  return firstMessage !== "" ? firstMessage : shortSessionId(session.id);
}
