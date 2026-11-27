// @vitest-environment happy-dom
import { useDeferredContent, settleDeferredContent } from "../formatting/deferredContent.testSupport";
import { afterEach, expect, it, vi } from "vitest";
import { sessionsApi } from "../api";
import { FormattedText } from "./FormattedText";
import type { OwnerRunDialog } from "./OwnerRunDialog";

useDeferredContent();

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const target = { session: { id: "s1", cwd: "/work" }, machineId: "local", entryId: "a1" };
const proposalText = 'Run this:\n\n```pi-run cwd="/work/repo"\npwd; exit 7\n```\n\n> ```pi-run cwd="/q"\n> echo quoted\n> ```\n';

async function mount(text: string, ownerRun = true): Promise<FormattedText> {
  const view = new FormattedText();
  view.text = text;
  if (ownerRun) view.ownerRun = target;
  document.body.append(view);
  await settleDeferredContent(view);
  await settleDeferredContent(view);
  return view;
}

it("a committed assistant message's top-level pi-run block gets a Review button; a quoted one does not", async () => {
  const view = await mount(proposalText);
  const buttons = view.renderRoot.querySelectorAll(".owner-run-button");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.textContent).toBe("Review command…");
  expect(view.renderRoot.querySelector("blockquote .owner-run-invalid")?.textContent).toContain("only a closed top-level block runs");
});

it("a quoted copy of the same block gets no button", async () => {
  const block = '```pi-run cwd="/work/repo"\npwd\n```';
  const view = await mount(`${block}\n\n> ${block.replaceAll("\n", "\n> ")}\n`);
  expect(view.renderRoot.querySelectorAll(".owner-run-button")).toHaveLength(1);
  expect(view.renderRoot.querySelector("blockquote .owner-run-button")).toBeNull();
});

it("text without a run target (user messages, tool output) shows pi-run blocks as plain code", async () => {
  const view = await mount(proposalText, false);
  expect(view.renderRoot.querySelector(".owner-run-button, .owner-run-invalid")).toBeNull();
  expect(view.renderRoot.textContent).toContain("pwd; exit 7");
});

it("Review opens the confirmation with folder and literal command; Cancel sends nothing and Run once sends the named proposal and closes", async () => {
  const ownerRun = vi.spyOn(sessionsApi, "ownerRun").mockResolvedValue({ status: "started" });
  const view = await mount(proposalText);
  view.renderRoot.querySelector<HTMLButtonElement>(".owner-run-button")?.click();
  let dialog = document.querySelector<OwnerRunDialog>("owner-run-dialog");
  await dialog?.updateComplete;
  expect(dialog?.renderRoot.textContent).toContain("/work/repo");
  expect(dialog?.renderRoot.querySelector(".command")?.textContent).toBe("pwd; exit 7");
  dialog?.renderRoot.querySelector<HTMLButtonElement>(".cancel")?.click();
  expect(document.querySelector("owner-run-dialog")).toBeNull();
  expect(ownerRun).not.toHaveBeenCalled();

  view.renderRoot.querySelector<HTMLButtonElement>(".owner-run-button")?.click();
  dialog = document.querySelector<OwnerRunDialog>("owner-run-dialog");
  await dialog?.updateComplete;
  dialog?.renderRoot.querySelector<HTMLButtonElement>(".run")?.click();
  await vi.waitFor(() => {
    expect(document.querySelector("owner-run-dialog")).toBeNull();
  });
  expect(ownerRun).toHaveBeenCalledWith(target.session, "a1", { mode: "run", cwd: "/work/repo", command: "pwd; exit 7" }, "local");
});
