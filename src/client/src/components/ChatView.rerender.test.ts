// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { FormattedText } from "./FormattedText";
import type { SessionActivity, SessionStatus } from "../api";

const status: SessionStatus = {
  sessionId: "session", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
};
const activity = (): SessionActivity => ({ sessionId: "session", phase: "active", label: "agent running", at: new Date().toISOString() });

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

const context = () => ({ machineId: "local", projectId: "p", workspaceId: "w", root: "/work" });

async function settle(view: ChatView) {
  await view.updateComplete;
  await Promise.all([...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")].map((part) => part.updateComplete));
}

it("does not re-render the transcript for activity ticks or equal workspace contexts", async () => {
  const view = new ChatView();
  view.sessionId = "session";
  view.workspaceContext = context();
  view.messages = Array.from({ length: 5 }, (_, index) => ({ role: "assistant", parts: [{ type: "text", text: `**message ${String(index)}**` }] }));
  document.body.append(view);
  await settle(view);
  const render = vi.spyOn(FormattedText.prototype, "render");

  view.workspaceContext = context();
  view.status = { ...status };
  view.activity = activity();
  await settle(view);
  view.activity = activity();
  await settle(view);
  expect(render).not.toHaveBeenCalled();

  view.messages = [...view.messages, { role: "assistant", parts: [{ type: "text", text: "new" }] }];
  await settle(view);
  expect(render).toHaveBeenCalledTimes(1);

  view.workspaceContext = { ...context(), workspaceId: "other" };
  await settle(view);
  expect(render).toHaveBeenCalledTimes(7);
});
