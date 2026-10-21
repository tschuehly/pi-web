// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY } from "../extensionStatusSnapshots";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function status(activityItems: unknown[] = []): SessionStatus {
  return {
    sessionId: "s", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: 3.68,
    contextUsage: { tokens: 162_000, contextWindow: 1_000_000, percent: 16.2 },
    extensionStatuses: { [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: activityItems }) },
  };
}

async function mount(dense: boolean, showUsage: boolean, setup: (editor: PromptEditor) => void = () => undefined): Promise<ShadowRoot> {
  const editor = new PromptEditor();
  editor.dense = dense;
  editor.showUsage = showUsage;
  setup(editor);
  document.body.append(editor);
  await editor.updateComplete;
  if (editor.shadowRoot === null) throw new Error("no shadow root");
  return editor.shadowRoot;
}

describe("dense composer", () => {
  it("lays the input, meta, and actions out as one row, with stop only while there is work to stop", async () => {
    const root = await mount(true, true, (editor) => { editor.status = status(); });

    expect(root.querySelector(".actions")).toBeNull();
    expect(root.querySelector(".input-row > .editor-wrap + .dense-meta > model-effort-picker")).not.toBeNull();
    expect(root.querySelector(".dense-meta > working-mode-controls[compact]")).not.toBeNull();
    expect(root.querySelector(".dense-meta + .composer-actions .send-button")).not.toBeNull();
    expect(root.querySelector(".stop-button")).toBeNull();
    expect(root.querySelector(".cm-placeholder")?.textContent).toBe("Message…");

    const busy = await mount(true, true, (editor) => { editor.status = status(); editor.canStop = true; });
    expect(busy.querySelector(".composer-actions .stop-button")).not.toBeNull();
  });

  it("shows the context as a ring whose tooltip carries the numbers and the cost, keeping the cost for screen readers", async () => {
    const root = await mount(true, true, (editor) => { editor.status = status(); });

    const context = root.querySelector<HTMLElement>('[data-usage="context"]');
    expect(context?.querySelector('[aria-hidden="true"]')?.textContent.trim()).toBe("");
    expect(context?.title).toContain("162k / 1.0M");
    expect(context?.title).toContain("Session cost: $3.68");
    expect(root.querySelector('[data-usage="cost"]')?.classList.contains("visually-hidden")).toBe(true);
  });

  it("keeps the regular composer's meta row with visible context and cost", async () => {
    const regular = await mount(false, true, (editor) => { editor.status = status(); });
    expect(regular.querySelector(".input-row > .composer-actions")).toBeNull();
    expect(regular.querySelector("footer > .input-row > .editor-wrap")).not.toBeNull();
    expect(regular.querySelector("footer > .input-row + .actions > .composer-actions .send-button")).not.toBeNull();
    expect(regular.querySelector("working-mode-controls[compact]")).toBeNull();
    expect(regular.querySelector('[data-usage="cost"]')?.classList.contains("visually-hidden")).toBe(false);
  });
});

describe("dense Activity badge", () => {
  const running = [{ id: "a", kind: "subagent", name: "Review" }, { id: "b", kind: "worker", name: "Rows" }, { id: "c", kind: "subagent", name: "Done", activity: "success" }];

  it("counts the roster's entries, names them in its label, and toggles the roster", async () => {
    const toggle = vi.fn();
    const root = await mount(true, true, (editor) => { editor.status = status(running); editor.onToggleActivity = toggle; });

    const badge = root.querySelector<HTMLButtonElement>(".input-row > .activity-badge");
    expect(badge?.textContent.trim()).toBe("3");
    expect(badge?.getAttribute("aria-label")).toBe("Activity: 1 to collect · 2 running");
    expect(badge?.getAttribute("aria-expanded")).toBe("false");
    badge?.click();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("re-renders on an activity-only status change and hides with nothing to show", async () => {
    let editor: PromptEditor | undefined;
    const root = await mount(true, true, (created) => { editor = created; created.status = status(); created.onToggleActivity = () => undefined; });
    expect(root.querySelector(".activity-badge")).toBeNull();

    if (editor === undefined) throw new Error("no editor");
    editor.status = status(running.slice(0, 1));
    await editor.updateComplete;
    expect(root.querySelector(".activity-badge")?.textContent.trim()).toBe("1");
  });

  it("is absent outside a Grid tile", async () => {
    const root = await mount(false, true, (editor) => { editor.status = status(running); editor.onToggleActivity = () => undefined; });
    expect(root.querySelector(".activity-badge")).toBeNull();
  });
});

describe("dense toggle", () => {
  it("keeps the live editor and its draft when the layout switches between dense and regular", async () => {
    const editor = new PromptEditor();
    editor.dense = true;
    document.body.append(editor);
    await editor.updateComplete;
    const view = editor.view;
    if (view === undefined) throw new Error("no editor view");
    view.dispatch({ changes: { from: 0, insert: "draft" } });

    editor.dense = false;
    await editor.updateComplete;

    const root = editor.shadowRoot;
    expect(root?.querySelector(".markdown-editor .cm-editor")).toBe(view.dom);
    expect(editor.view?.state.doc.toString()).toBe("draft");
    expect(root?.querySelector(".cm-placeholder")?.textContent).not.toBe("Message…");
  });
});
