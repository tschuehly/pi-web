// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { FULL_ACCESS_STATUS_KEY, FullAccessToggle } from "./FullAccessToggle";

afterEach(() => { document.body.replaceChildren(); });

function status(state?: string): SessionStatus {
  return {
    sessionId: "session-1", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    extensionStatuses: state === undefined ? {} : { [FULL_ACCESS_STATUS_KEY]: state },
  };
}

async function toggle(state: string | undefined, onRunCommand?: (command: string) => Promise<void>) {
  const element = new FullAccessToggle();
  element.status = status(state);
  if (onRunCommand) element.onRunCommand = onRunCommand;
  document.body.append(element);
  await element.updateComplete;
  return { element, button: () => element.shadowRoot?.querySelector("button") ?? null };
}

describe("FullAccessToggle", () => {
  it("is absent unless the host reports the write fence's state", async () => {
    expect((await toggle(undefined)).button()).toBeNull();
    expect((await toggle("full access")).button()).toBeNull();
  });

  it("fenced: a muted shield that asks for full access", async () => {
    const run = vi.fn(() => Promise.resolve());
    const { button } = await toggle("off", run);
    const fenced = button();
    expect(fenced?.getAttribute("aria-pressed")).toBe("false");
    expect(fenced?.textContent.trim()).toBe("");
    expect(fenced?.title).toMatch(/Write fence on/);
    fenced?.click();
    expect(run).toHaveBeenCalledWith("/full-access on");
  });

  it("full access: a labelled chip that fences again; disabled while the owner's dialog is open", async () => {
    let answer: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    const { element, button } = await toggle("on", run);
    expect(button()?.getAttribute("aria-pressed")).toBe("true");
    expect(button()?.textContent).toContain("Full access");
    button()?.click();
    expect(run).toHaveBeenCalledWith("/full-access off");
    await element.updateComplete;
    expect(button()?.disabled).toBe(true);
    answer();
    await Promise.resolve();
    await element.updateComplete;
    expect(button()?.disabled).toBe(false);
  });
});
