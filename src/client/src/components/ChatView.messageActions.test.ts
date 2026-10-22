// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayedMessageActionAvailabilityContext, DisplayedMessageActionContext,  EntryMessageActionContribution, MessageActionAvailabilityContext, MessageActionContext, MessageActionContribution, MessageActionFeedback } from "../../../plugin-api";
import * as clipboard from "../clipboard";

import { corePlugin } from "../plugins/core";
import { PluginRegistry } from "../plugins/registry";
import type { ChatLine } from "./shared";

import { ChatView } from "./ChatView";
import {  useDeferredContent } from "../formatting/deferredContent.testSupport";

useDeferredContent();

const base = {
  machine: { id: "local", name: "Local", kind: "local" },
  session: { id: "session-1", cwd: "/repo", archived: false, pending: false, busy: false },
} as const;

function invocation(input: MessageActionAvailabilityContext): MessageActionContext {
  return {
    ...input,
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    navigate: vi.fn(),
    projects: { machineId: "local", listProjects: vi.fn(), suggestDirectories: vi.fn() },
    history: { fork: vi.fn(), goBack: vi.fn() },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(contributions?: MessageActionContribution[]) {
  const registry = new PluginRegistry();
  await registry.register({ id: "core", plugin: corePlugin });
  if (contributions !== undefined) await registry.register({ id: "custom", plugin: {
    apiVersion: 4, name: "Custom", activate: () => ({ contributions: { messageActions: contributions } }),
  } });
  const view = new ChatView();
  view.sessionId = base.session.id;
  view.messages = [{ role: "user", entryId: "entry-1", parts: [{ type: "text", text: "Hello" }] }];
  view.messageActionContext = base;
  view.messageActions = registry.getMessageActions("local");
  const context = invocation({ ...base, message: { entryId: "entry-1", role: "user", text: "Hello" } });
  view.onMessageAction = (input, id) => registry.runMessageAction(id, input, () => context);
  view.onDisplayedMessageAction = (input, id) => registry.runDisplayedMessageAction(id, input, () => displayedInvocation(input));
  document.body.append(view);
  await view.updateComplete;
  return { view, registry, context };
}

function displayedInvocation(input: DisplayedMessageActionAvailabilityContext): DisplayedMessageActionContext {
  return {
    ...input,
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    navigate: vi.fn(),
    projects: { machineId: "local", listProjects: vi.fn(), suggestDirectories: vi.fn() },
  };
}

function button(view: ChatView, label: string): HTMLButtonElement {
  const result = buttons(view).find((button) => button.getAttribute("aria-label") === label);
  if (result === undefined) throw new Error(`Missing message action ${label}`);
  return result;
}

function buttons(view: ChatView) {
  return Array.from(view.renderRoot.querySelectorAll<HTMLButtonElement>(".msg-action"));
}

async function settle(view: ChatView) {
  await view.updateComplete;
  await view.updateComplete;
}

describe("plugin-defined transcript message actions", () => {
  it("hides clone and go-back in a Durable Chat that does not support forking or tree navigation; copy stays", async () => {
    const { view } = await mount();
    view.status = { sessionId: base.session.id, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, capabilities: [] };
    await settle(view);
    expect(buttons(view).map((button) => button.getAttribute("aria-label"))).toEqual(["Copy user message"]);
    view.status = { ...view.status, capabilities: ["fork", "tree"] };
    await settle(view);
    expect(buttons(view)).toHaveLength(3);
  });

  it("preserves core confirmation for cloning through the public callback", async () => {
    const label = "Clone session from this message";
    const { view, context } = await mount();
    expect(buttons(view).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Clone session from this message", "Go back to this message", "Copy user message",
    ]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    button(view, label).click();
    await settle(view);
    expect(confirm).toHaveBeenCalledWith("Are you sure you want to fork this session?");
    expect(context.history.fork).not.toHaveBeenCalled();
    await vi.waitFor(() => { expect(button(view, label).disabled).toBe(false); });
    confirm.mockReturnValue(true);
    button(view, label).click();
    await settle(view);
    await vi.waitFor(() => { expect(context.history.fork).toHaveBeenCalledOnce(); });
  });

  it("delegates go-back to the browser helper without a blanket confirmation", async () => {
    const { view, context } = await mount();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    button(view, "Go back to this message").click();
    await settle(view);
    expect(context.history.goBack).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("runs arbitrary plugin workflows without a host confirmation and filters availability per message", async () => {
    const run = vi.fn<EntryMessageActionContribution["run"]>();
    const { view, context } = await mount([
      { id: "quote", title: "Quote", visible: ({ message }) => message.role === "user", enabled: ({ message }) => message.text !== "Blocked", run },
      { id: "hidden", title: "Hidden", visible: () => false, run },
    ]);
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    button(view, "Quote").click();
    await settle(view);
    expect(run).toHaveBeenCalledExactlyOnceWith(context);
    expect(confirm).not.toHaveBeenCalled();
    expect(buttons(view).some((button) => button.title === "Hidden")).toBe(false);
    view.messages = [{ role: "user", entryId: "entry-2", parts: [{ type: "text", text: "Blocked" }] }];
    await settle(view);
    expect(button(view, "Quote").disabled).toBe(true);
    view.messages = [{ role: "assistant", entryId: "entry-3", parts: [{ type: "text", text: "Answer" }] }];
    await settle(view);
    expect(buttons(view).some((button) => button.title === "Quote")).toBe(false);
  });

  it("offers only opted-in display actions without a durable entry", async () => {
    const { view } = await mount();
    view.messages = [{ role: "assistant", parts: [{ type: "text", text: "Streaming" }] }];
    await view.updateComplete;
    expect(buttons(view).map((button) => button.title)).toEqual(["Copy message"]);
  });

  it("copies through the plugin registry, preserves original text and renews transient feedback", async () => {
    vi.useFakeTimers();
    const writeText = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue(true);
    const { view } = await mount();
    view.messages = [{ role: "assistant", parts: [
      { type: "thinking", text: "Private reasoning" },
      { type: "text", text: "  First  ", displayText: "Displayed differently" },
      { type: "text", text: "   " },
      { type: "text", text: " Second\n" },
    ] }];
    await settle(view);
    expect(buttons(view).map((button) => button.title)).toEqual(["Copy message"]);
    button(view, "Copy assistant message").click();
    await settle(view);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("First\n\nSecond");
    await vi.waitFor(() => { expect(button(view, "Copied assistant message").title).toBe("Copied"); });
    expect(button(view, "Copied assistant message").textContent).toContain("✓");
    await vi.advanceTimersByTimeAsync(800);
    button(view, "Copied assistant message").click();
    await vi.waitFor(() => { expect(button(view, "Copied assistant message").disabled).toBe(false); });
    await vi.advanceTimersByTimeAsync(800);
    expect(button(view, "Copied assistant message").title).toBe("Copied");
    await vi.advanceTimersByTimeAsync(400);
    await settle(view);
    expect(button(view, "Copy assistant message").title).toBe("Copy message");
  });

  it("has no built-in Copy fallback when the contribution is absent", async () => {
    const { view } = await mount();
    view.messageActions = view.messageActions.filter((action) => action.id !== "core:message.copy");
    await settle(view);
    expect(buttons(view).map((button) => button.title)).toEqual(["Clone session from this message", "Go back to this message"]);
  });

  it("lets Copy run while an entry workflow is pending and reports clipboard failure without success feedback", async () => {
    const writeText = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue(false);
    const { view } = await mount();
    let finish: (() => void) | undefined;
    view.onMessageAction = () => new Promise<void>((resolve) => { finish = resolve; });
    button(view, "Go back to this message").click();
    await settle(view);
    expect(button(view, "Go back to this message").disabled).toBe(true);
    expect(button(view, "Copy user message").disabled).toBe(false);
    button(view, "Copy user message").click();
    await settle(view);
    expect(writeText).toHaveBeenCalledWith("Hello");
    expect(button(view, "Copy user message").title).toBe("Copy message");
    await vi.waitFor(() => { expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toBe("Unable to copy message to the clipboard."); });
    finish?.();
    await settle(view);
  });

  it("shows generic plugin feedback only at its originating display target and clears it on selection/disconnect", async () => {
    vi.useFakeTimers();
    const { view } = await mount([{ target: "display", id: "mark", title: "Mark", run: () => ({ title: "Marked" }) }]);
    view.messages = [
      { role: "user", entryId: "shared", parts: [{ type: "text", text: "One" }] },
      { role: "user", entryId: "shared", parts: [{ type: "text", text: "Two" }] },
    ];
    await settle(view);
    button(view, "Mark").click();
    await settle(view);
    expect(buttons(view).filter((button) => button.title === "Marked")).toHaveLength(1);
    expect(buttons(view).filter((button) => button.title === "Mark")).toHaveLength(1);
    view.machineId = "remote";
    await settle(view);
    expect(buttons(view).filter((button) => button.title === "Marked")).toHaveLength(0);
    button(view, "Mark").click();
    await settle(view);
    view.remove();
    document.body.append(view);
    await settle(view);
    expect(buttons(view).filter((button) => button.title === "Marked")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1200);
    await settle(view);
  });

  it.each(["selection", "remount"])("ignores late plugin feedback after %s retires the invocation", async (change) => {
    const { view } = await mount([{ target: "display", id: "save", title: "Save", run: () => undefined }]);
    let finish: ((feedback: MessageActionFeedback) => void) | undefined;
    const result = new Promise<MessageActionFeedback>((resolve) => { finish = resolve; });
    view.onDisplayedMessageAction = () => result;
    button(view, "Save").click();
    await settle(view);
    if (change === "selection") {
      view.sessionId = "other";
      await settle(view);
      view.sessionId = base.session.id;
    } else {
      view.remove();
      document.body.append(view);
    }
    await settle(view);
    finish?.({ title: "Saved" });
    await result;
    await settle(view);
    expect(buttons(view).some((button) => button.title === "Saved")).toBe(false);
    expect(button(view, "Save").disabled).toBe(false);
  });

  it("disables core history actions while busy but leaves Copy and other plugin policy independent", async () => {
    const { view } = await mount([{ id: "note", title: "Note", run: () => undefined }]);
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    view.messageActionContext = { ...base, session: { ...base.session, busy: true } };
    await settle(view);
    button(view, "Clone session from this message").click();
    expect(confirm).not.toHaveBeenCalled();
    expect(button(view, "Copy user message").disabled).toBe(false);
    expect(button(view, "Note").disabled).toBe(false);
    view.messageActionContext = base;
    view.onMessageAction = vi.fn(() => Promise.reject(new Error("History changed")));
    await settle(view);
    button(view, "Go back to this message").click();
    await settle(view);
    expect(view.renderRoot.querySelector('[role="alert"]')?.textContent).toBe("History changed");
  });

  it("does not repeat historical availability checks or fetch on unrelated stream/render updates", async () => {
    const visible = vi.fn<NonNullable<EntryMessageActionContribution["visible"]>>(() => true);
    const enabled = vi.fn<NonNullable<EntryMessageActionContribution["enabled"]>>(() => true);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { view, registry } = await mount([{ id: "note", title: "Note", visible, enabled, run: () => undefined }]);
    const history = view.messages[0];
    if (history === undefined) throw new Error("Expected historical message");
    expect(visible).toHaveBeenCalledTimes(1);
    for (const text of ["One", "Two", "Three"]) {
      view.messages = [history, { role: "assistant", parts: [{ type: "text", text }] }];
      // The app makes new small snapshots/lists on each render; identities of
      // the registered actions and unchanged transcript lines remain stable.
      view.messageActionContext = { machine: { ...base.machine }, session: { ...base.session } };
      view.messageActions = registry.getMessageActions("local");
      await settle(view);
    }
    expect(visible).toHaveBeenCalledTimes(1);
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    const updated: ChatLine = { ...history, parts: [{ type: "text", text: "Changed" }] };
    view.messages = [updated];
    await settle(view);
    expect(visible).toHaveBeenCalledTimes(2);
    expect(visible).toHaveBeenLastCalledWith(expect.objectContaining({ message: { entryId: "entry-1", role: "user", text: "Changed" } }));
    view.messageActionContext = { ...base, session: { ...base.session, archived: true } };
    await settle(view);
    expect(enabled).toHaveBeenCalledTimes(3);
    expect(button(view, "Clone session from this message").disabled).toBe(true);
  });
});
