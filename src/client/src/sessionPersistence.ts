import type { SessionInfo, SessionStatus } from "./api";
import { chatSupports } from "../../shared/apiTypes";
import { isCachedNewSessionInfo } from "./cachedNewSessions";

export type SessionPersistenceState = "persisted" | "transient" | "unknown";

/**
 * All supported runtimes report persisted/transient session state
 * authoritatively, so a missing `persisted` signal is `unknown`, never an
 * implicit "persisted".
 */
export function sessionPersistenceState(session: SessionInfo | undefined, status?: SessionStatus): SessionPersistenceState {
  if (session === undefined) return "unknown";
  const statusPersisted = status?.sessionId === session.id ? status.persisted : undefined;
  const persisted = statusPersisted ?? session.persisted;
  if (persisted === true) return "persisted";
  if (persisted === false || isCachedNewSessionInfo(session)) return "transient";
  return "unknown";
}

/** A Durable Chat cannot be archived until it reports the capability. */
export function isArchivableSessionInfo(session: SessionInfo | undefined, status?: SessionStatus): boolean {
  return session !== undefined && session.archived !== true && sessionPersistenceState(session, status) === "persisted"
    && chatSupports(status?.sessionId === session.id ? status : session, "archive");
}

export function isTransientNewSessionInfo(session: SessionInfo | undefined, status?: SessionStatus): boolean {
  return session !== undefined && session.archived !== true && sessionPersistenceState(session, status) === "transient";
}
