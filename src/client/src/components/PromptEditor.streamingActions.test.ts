// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("PromptEditor streaming actions", () => {
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
