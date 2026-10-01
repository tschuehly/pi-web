import type { SessionRef } from "../../../shared/apiTypes";
import { resolveAppWebSocketUrl } from "../appUrl";
import { sessionEventsPath } from "./urls";

export function sessionEvents(session: SessionRef, machineId = "local"): WebSocket {
  return openSocket(sessionEventsPath(session, machineId));
}

export function globalSessionEvents(machineId = "local"): WebSocket {
  return openSocket(`${machinePrefix(machineId)}/sessions/events`);
}

export function realtimeEvents(machineId = "local"): WebSocket {
  return openSocket(`${machinePrefix(machineId)}/events`);
}

function openSocket(path: string): WebSocket {
  const socket = new WebSocket(resolveAppWebSocketUrl(path));
  socket.binaryType = "arraybuffer";
  return socket;
}

function machinePrefix(machineId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}`;
}
