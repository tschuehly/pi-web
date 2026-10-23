// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedSessionMessage, SessionInfo, SessionStatus } from "../api";
import { initialAppState, type AppState } from "../appState";
import { WorkbenchChatSession } from "../controllers/workbenchSessionFocus";
import type { SessionControllerDependencies } from "../controllers/sessionController";
import { defaultApi } from "../controllers/sessionController.testSupport";
import type { ChatView } from "./ChatView";
import type { PromptEditor } from "./PromptEditor";
import { WorkbenchChatPane } from "./WorkbenchChatPane";

// Every Workbench Chat, focused or a Grid tile, is this pane: Edit/Revert and Recall replace the composer text, so they must
// never silently overwrite an unsent draft and must lock the composer until the replacement lands.
const session: SessionInfo = { id: "session-1", cwd: "/repo", path: "/repo/session.jsonl", created: "now", modified: "now", messageCount: 1, firstMessage: "Hello" };
const runtimes: WorkbenchChatSession[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("asks before Edit & resend replaces an unsent draft, and leaves history alone when declined", async () => {
  const { pane, runtime, editor } = await mountPane("unsent draft");
  const back = vi.spyOn(runtime.sessions, "actOnMessage").mockResolvedValue(undefined);
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  messageButton(pane, "Edit and resend").click();
  await vi.waitFor(() => { expect(confirm).toHaveBeenCalledExactlyOnceWith("Going back will replace your unsent draft. Continue?"); });
  expect(back).not.toHaveBeenCalled();
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");
  expect(editor.disabled).toBe(false);
});

it("locks the composer while a confirmed Edit is pending and unlocks once the text is restored", async () => {
  const { pane, runtime, editor } = await mountPane("unsent draft");
  const request = deferred();
  const back = vi.spyOn(runtime.sessions, "actOnMessage").mockReturnValue(request.promise);
  vi.stubGlobal("confirm", () => true);
  messageButton(pane, "Edit and resend").click();
  await vi.waitFor(() => { expect(back).toHaveBeenCalledWith("entry-1", "back"); });
  expect(editor.disabled).toBe(true);
  await pane.replacePromptEditorText({ machineId: "local", sessionId: session.id, text: "Hello" });
  await pane.updateComplete;
  expect(editor.disabled).toBe(false);
  expect(editor.view?.state.doc.toString()).toBe("Hello");
  request.resolve();
});

it("reverts to an assistant message without asking, since it keeps the draft", async () => {
  const { pane, runtime } = await mountPane("unsent draft", "assistant");
  const back = vi.spyOn(runtime.sessions, "actOnMessage").mockResolvedValue(undefined);
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  messageButton(pane, "Revert to here").click();
  await vi.waitFor(() => { expect(back).toHaveBeenCalledWith("entry-1", "back"); });
  expect(confirm).not.toHaveBeenCalled();
});

it("offers queue Recall, Remove and kind toggle, confirming consequences and the unsent draft before Recall", async () => {
  const queued: QueuedSessionMessage[] = [{ kind: "steer", text: "adjust" }, { kind: "followUp", text: "next" }];
  const { pane, runtime, editor, view } = await mountPane("unsent draft", "user", queued);
  const mutate = vi.spyOn(runtime.sessions, "mutateQueuedMessage").mockResolvedValue(undefined);
  const confirm = vi.fn<(text: string) => boolean>().mockReturnValueOnce(true).mockReturnValueOnce(false);
  vi.stubGlobal("confirm", confirm);
  expect(queueButton(view, "Switch to Queue").disabled).toBe(false);
  queueButton(view, "Recall queued message").click();
  await vi.waitFor(() => { expect(confirm).toHaveBeenCalledTimes(2); });
  expect(confirm.mock.calls.map(([text]) => text)).toEqual([
    "Recall this message?\n\nThis will also remove 1 queued follow-up.",
    "Recalling will replace your unsent draft. Continue?",
  ]);
  expect(mutate).not.toHaveBeenCalled();
  expect(editor.view?.state.doc.toString()).toBe("unsent draft");

  editor.replaceText("");
  await editor.updateComplete;
  const request = deferred();
  mutate.mockReturnValue(request.promise);
  confirm.mockReset().mockReturnValue(true);
  queueButton(view, "Recall queued message").click();
  await vi.waitFor(() => { expect(mutate).toHaveBeenCalledWith("edit", 0, queued); });
  expect(editor.disabled).toBe(true);
  await pane.updateComplete;
  await view.updateComplete;
  // One draft-replacing action at a time: queue controls wait for the pending one.
  expect(queueButton(view, "Remove queued message").disabled).toBe(true);
  request.resolve();
  await vi.waitFor(() => { expect(editor.disabled).toBe(false); });
  await view.updateComplete;
  queueButton(view, "Remove queued message").click();
  await vi.waitFor(() => { expect(mutate).toHaveBeenLastCalledWith("remove", 0, queued); });
});

async function mountPane(draft: string, role: "user" | "assistant" = "user", queuedMessages: QueuedSessionMessage[] = [], dependencies: Partial<SessionControllerDependencies> = {}) {
  const status: SessionStatus | undefined = queuedMessages.length === 0 ? undefined : { sessionId: session.id, isStreaming: true, isCompacting: false, isBashRunning: false,
    pendingMessageCount: queuedMessages.length, queuedMessages, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const state: AppState = { ...initialAppState(), selectedSession: session, status, messages: [{ role, entryId: "entry-1", parts: [{ type: "text", text: "Hello" }] }] };
  const pane = new WorkbenchChatPane();
  const runtime = new WorkbenchChatSession(state, (chat) => { pane.app = chat.state; }, { socket: { connect: vi.fn(), setHandler: vi.fn(), close: vi.fn() }, ...dependencies });
  runtimes.push(runtime);
  pane.runtime = runtime;
  pane.app = runtime.state;
  pane.focused = true;
  document.body.append(pane);
  await pane.updateComplete;
  const editor = pane.querySelector<PromptEditor>("prompt-editor");
  const view = pane.querySelector<ChatView>("chat-view");
  if (editor === null || view === null) throw new Error("Expected the pane's composer and transcript");
  await editor.updateComplete;
  await view.updateComplete;
  editor.replaceText(draft);
  await editor.updateComplete;
  return { pane, runtime, editor, view };
}

function messageButton(pane: WorkbenchChatPane, label: string): HTMLButtonElement {
  const button = pane.querySelector("chat-view")?.shadowRoot?.querySelector<HTMLButtonElement>(`.msg-action[aria-label="${label}"]`);
  if (button === null || button === undefined) throw new Error(`Expected ${label} message action`);
  return button;
}

function queueButton(view: ChatView, label: string): HTMLButtonElement {
  const button = view.shadowRoot?.querySelector<HTMLButtonElement>(`.queued-action[aria-label="${label}"]`);
  if (button === null || button === undefined) throw new Error(`Expected ${label} queue control`);
  return button;
}

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<undefined>((complete) => { resolve = () => { complete(undefined); }; });
  if (resolve === undefined) throw new Error("Expected a promise resolver");
  return { promise, resolve };
}

it("hosts the Chat in the Workbench presentation and passes the configured streaming send behavior to the composer", async () => {
  const { pane, editor, view } = await mountPane("");
  expect(view.hasAttribute("workbench")).toBe(true);
  expect(view.behaviors.holdReadingPlace).toBe(true);
  expect(editor.defaultStreamingBehavior).toBe("steer");
  pane.defaultStreamingBehavior = "followUp";
  await pane.updateComplete;
  expect(editor.defaultStreamingBehavior).toBe("followUp");
});

it("shows a failed Stop (or any failed action) of this Chat in its pane until dismissed; other Chats' failures stay out (fleet P011)", async () => {
  const abort = vi.fn(() => Promise.reject(new Error("fixture stop refused")));
  const { pane, runtime } = await mountPane("", "user", [{ kind: "followUp", text: "queued" }], { api: { ...defaultApi, abort } });
  await runtime.sessions.stopActiveWork();
  await pane.updateComplete;
  expect(abort).toHaveBeenCalledOnce();
  const alert = pane.querySelector<HTMLElement>(".chat-error [role=alert]");
  expect(alert?.textContent).toContain("fixture stop refused");
  expect(runtime.state.status?.isStreaming).toBe(true);
  alert?.querySelector<HTMLButtonElement>("button[aria-label='Dismiss error']")?.click();
  await pane.updateComplete;
  expect(pane.querySelector(".chat-error")).toBeNull();
  runtime.patch({ browserErrors: { other: { scope: { kind: "session", machineId: "local", sessionId: "session-2" }, message: "elsewhere" } } });
  await pane.updateComplete;
  expect(pane.querySelector(".chat-error")).toBeNull();
});
