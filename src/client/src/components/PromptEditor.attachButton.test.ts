// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { html } from "lit";
import { PromptEditor } from "./PromptEditor";
import { clearStagedAttachments, emptyStagedAttachmentDraft, saveStagedAttachments } from "../promptAttachmentStaging";

beforeEach(() => {
  // CodeMirror measurement is a browser concern; keep this test on the control's native interaction.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  clearStagedAttachments("local:appearance-controls");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders supplied chat navigation inside the editor", async () => {
  const editor = new PromptEditor();
  const jump = vi.fn();
  editor.chatNavigation = html`<nav aria-label="Chat navigation"><button @click=${jump}>Jump to end</button></nav>`;
  document.body.append(editor);
  await editor.updateComplete;
  const navigation = editor.renderRoot.querySelector(".editor-chat-navigation");
  expect(navigation?.parentElement?.classList.contains("editor-wrap")).toBe(true);
  const button = navigation?.querySelector("button");
  if (!button) throw new Error("Expected supplied chat navigation");
  button.click();
  expect(jump).toHaveBeenCalledOnce();
});

it("keeps attachment delivery and removal wired through native shared controls", async () => {
  const key = "local:appearance-controls";
  saveStagedAttachments(key, { ...emptyStagedAttachmentDraft(), attachments: [{ id: "file-1", kind: "file", name: "screenshot.png", mimeType: "text/plain", data: "QUJD", size: 3 }] });
  const editor = new PromptEditor();
  editor.sessionId = "appearance-controls";
  document.body.append(editor);
  await editor.updateComplete;
  const delivery = editor.renderRoot.querySelector<HTMLSelectElement>(".attachments select");
  const remove = editor.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Remove screenshot.png"]');
  if (delivery === null || remove === null) throw new Error("Expected pending attachment controls");
  expect(remove.type).toBe("button");
  delivery.value = "folder";
  delivery.dispatchEvent(new Event("change", { bubbles: true }));
  await editor.updateComplete;
  expect(delivery.value).toBe("folder");
  expect(localStorage.getItem("pi-web:attachment-delivery")).toBe("folder");
  remove.focus();
  expect(editor.shadowRoot?.activeElement).toBe(remove);
  remove.click();
  await editor.updateComplete;
  expect(editor.renderRoot.querySelector(".attachment-chip")).toBeNull();
});

it("removes plugin context by identity and retains the disabled contract", async () => {
  const editor = new PromptEditor();
  const chip = { id: "context", key: "context-key", pluginId: "test", target: { machineId: "local", sessionId: "appearance-controls" }, label: "Context", text: "Context content" };
  editor.promptChips = [chip];
  editor.onRemoveChip = vi.fn();
  document.body.append(editor);
  await editor.updateComplete;
  const remove = editor.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Remove Context"]');
  if (remove === null) throw new Error("Expected context removal control");
  expect(remove.type).toBe("button");
  remove.click();
  expect(editor.onRemoveChip).toHaveBeenCalledWith(chip);
  editor.disabled = true;
  await editor.updateComplete;
  expect(remove.disabled).toBe(true);
  remove.click();
  expect(editor.onRemoveChip).toHaveBeenCalledOnce();
});

it.each(["disabled", "sending"] as const)("opens the file picker and respects the composer's %s state", async (busyProperty) => {
  const editor = new PromptEditor();
  document.body.append(editor);
  await editor.updateComplete;
  const button = editor.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]');
  const input = editor.renderRoot.querySelector<HTMLInputElement>('input[type="file"]');
  if (button === null || input === null) throw new Error("Expected attachment controls");
  const open = vi.spyOn(input, "click").mockImplementation(() => undefined);
  expect(button.type).toBe("button");
  expect(input.multiple).toBe(true);
  button.focus();
  expect(editor.shadowRoot?.activeElement).toBe(button);
  button.click();
  expect(open).toHaveBeenCalledOnce();

  editor[busyProperty] = true;
  await editor.updateComplete;
  expect(button.disabled).toBe(true);
  button.click();
  expect(open).toHaveBeenCalledOnce();
});
