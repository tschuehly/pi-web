// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("PromptEditor streaming actions", () => {
  it("uses a distinct steer glyph instead of the idle send glyph", async () => {
    const idle = new PromptEditor();
    document.body.append(idle);
    await idle.updateComplete;
    const sendGlyph = iconPaths(requiredButton(idle, ".send-button"));

    const streaming = new PromptEditor();
    streaming.canSteer = true;
    document.body.append(streaming);
    await streaming.updateComplete;
    const steerGlyph = iconPaths(requiredButton(streaming, ".send-button"));

    expect(sendGlyph).not.toEqual(steerGlyph);
  });

  it("uses a distinct queue glyph for the secondary action when steering", async () => {
    const streaming = new PromptEditor();
    streaming.canSteer = true;
    document.body.append(streaming);
    await streaming.updateComplete;
    const steerGlyph = iconPaths(requiredButton(streaming, ".send-button"));
    const queueGlyph = iconPaths(requiredButton(streaming, ".queue-button"));

    expect(steerGlyph).not.toEqual(queueGlyph);
  });

  it("disables idle Stop and enables it with the current-work title during compaction", async () => {
    const idle = new PromptEditor();
    document.body.append(idle);
    await idle.updateComplete;
    const idleStop = requiredButton(idle, ".stop-button");
    expect(idleStop.disabled).toBe(true);
    expect(idleStop.title).toBe("Nothing running");

    const compacting = new PromptEditor();
    compacting.isCompacting = true;
    compacting.canStop = true;
    document.body.append(compacting);
    await compacting.updateComplete;
    const compactingStop = requiredButton(compacting, ".stop-button");
    expect(compactingStop.disabled).toBe(false);
    expect(compactingStop.title).toBe("Stop current work");
  });

  it("makes steering primary and queues follow-ups from the secondary action", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn();
    editor.canSteer = true;
    editor.onSend = onSend;
    document.body.append(editor);
    await editor.updateComplete;

    const steer = requiredButton(editor, ".send-button");
    const followUp = requiredButton(editor, ".queue-button");
    expect(steer.getAttribute("aria-label")).toBe("Steer current response");
    expect(steer.title).toBe("Steer at the next available boundary");
    expect(followUp.getAttribute("aria-label")).toBe("Queue follow-up");

    editor.replaceText("Adjust now");
    steer.click();
    expect(onSend).toHaveBeenLastCalledWith("Adjust now", "steer", undefined, undefined, undefined);

    editor.replaceText("Then summarize");
    followUp.click();
    expect(onSend).toHaveBeenLastCalledWith("Then summarize", "followUp", undefined, undefined, undefined);
  });

  it("keeps queueing as the primary action during compaction", async () => {
    const steerer = new PromptEditor();
    steerer.canSteer = true;
    document.body.append(steerer);
    await steerer.updateComplete;
    const queueGlyph = iconPaths(requiredButton(steerer, ".queue-button"));

    const editor = new PromptEditor();
    const onSend = vi.fn();
    editor.canSteer = true;
    editor.isCompacting = true;
    editor.onSend = onSend;
    document.body.append(editor);
    await editor.updateComplete;

    const queue = requiredButton(editor, ".send-button");
    expect(queue.getAttribute("aria-label")).toBe("Queue message");
    expect(editor.shadowRoot?.querySelector(".queue-button")).toBeNull();
    expect(iconPaths(queue)).toEqual(queueGlyph);

    editor.replaceText("After compaction");
    queue.click();
    expect(onSend).toHaveBeenCalledWith("After compaction", "followUp", undefined, undefined, undefined);
  });
});

function requiredButton(editor: PromptEditor, selector: string): HTMLButtonElement {
  const button = editor.shadowRoot?.querySelector(selector);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Expected ${selector}`);
  return button;
}

function iconPaths(button: HTMLButtonElement): string[] {
  return [...button.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
}
