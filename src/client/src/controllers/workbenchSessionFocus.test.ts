import { describe, expect, it, vi } from "vitest";
import { api, type SessionInfo } from "../api";
import { initialAppState } from "../appState";
import { WorkbenchChatSession, WorkbenchSessionFocus } from "./workbenchSessionFocus";

const session = (id: string): SessionInfo => ({ id, cwd: `/work/${id}`, path: `/sessions/${id}.jsonl`, created: "now", modified: "now", messageCount: 1, firstMessage: id });

describe("Workbench focused-session seam", () => {
  it("projects the focused Chat without reselecting either runtime, and sends commands to its own session and machine", async () => {
    let shown = initialAppState();
    const machines = shown.machines;
    const statuses = shown.sessionStatuses;
    const focus = new WorkbenchSessionFocus((patch) => { shown = { ...shown, ...patch }; });
    const runCommand = vi.fn<typeof api.runCommand>().mockResolvedValue({ type: "done", message: "command result" });
    const socket = { connect: vi.fn(), setHandler: vi.fn(), close: vi.fn() };
    const first = new WorkbenchChatSession({ ...initialAppState(), selectedSession: session("first"), messages: [{ role: "assistant", parts: [{ type: "text", text: "First transcript" }] }] }, (chat, patch) => { focus.changed(chat, patch); }, { api: { ...api, runCommand }, socket });
    const second = new WorkbenchChatSession({ ...initialAppState(), selectedSession: session("second"), selectedMachine: { id: "remote", name: "Remote", kind: "remote", createdAt: "now", updatedAt: "now" } }, (chat, patch) => { focus.changed(chat, patch); }, { api: { ...api, runCommand }, socket });
    try {
      const transcript = first.state.messages;
      focus.focus(first);
      first.notifications.prepareSelectedSession(session("first"), "local");
      const inbox = shown.selectedNotificationInbox;
      focus.focus(second);
      expect(shown.selectedSession?.id).toBe("second");
      expect(shown.selectedMachine?.id).toBe("remote");
      expect(shown.machines).toBe(machines);
      expect(shown.sessionStatuses).toBe(statuses);
      expect(shown.selectedNotificationInbox).toBeUndefined();
      first.patch({ error: "First Chat failed", pendingAsks: [] });
      expect(shown.error).toBe("");
      await focus.current?.sessions.runCommand("/mode");
      expect(runCommand).toHaveBeenCalledWith(session("second"), "/mode", "remote");
      focus.focus(first);
      expect(focus.current?.sessions).toBe(first.sessions);
      expect(shown.messages).toBe(transcript);
      expect(shown.error).toBe("First Chat failed");
      expect(shown.selectedNotificationInbox).toBe(inbox);
      expect(socket.connect).not.toHaveBeenCalled();
      expect(socket.close).not.toHaveBeenCalled();
    } finally { first.dispose(); second.dispose(); }
  });

  it("leaves the chooser alone when a formerly focused Chat finishes or receives an update", () => {
    const publish = vi.fn();
    const focus = new WorkbenchSessionFocus(publish);
    const chat = new WorkbenchChatSession({ ...initialAppState(), selectedSession: session("first") }, (runtime, patch) => { focus.changed(runtime, patch); }, { socket: { connect: vi.fn(), setHandler: vi.fn(), close: vi.fn() } });
    try {
      focus.focus(chat);
      focus.clear();
      publish.mockClear();
      chat.patch({ messages: [{ role: "assistant", parts: [{ type: "text", text: "Finished in the background" }] }] });
      expect(publish).not.toHaveBeenCalled();
      expect(chat.state.messages).toHaveLength(1);
      expect(focus.current).toBeUndefined();
    } finally { chat.dispose(); }
  });
});
