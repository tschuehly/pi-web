// @vitest-environment happy-dom
import type { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingAskUser } from "../../../shared/apiTypes";
import { sessionsApi } from "../api";
import { settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";
import type { AskMarkdownField } from "./AskMarkdownField";
import { AskUserCard } from "./AskUserCard";
import type { OwnerRunDialog } from "./OwnerRunDialog";

useDeferredContent();

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

const session = { session: { id: "s1", cwd: "/work" }, machineId: "local" };
const block = (command: string) => `\`\`\`pi-run cwd="/work/repo"\n${command}\n\`\`\``;

function ask(extra: Partial<PendingAskUser> = {}): PendingAskUser {
  return {
    askId: "ask-1",
    askedAt: "",
    updatedAt: "",
    revision: "r1",
    turnsSinceUpdate: 0,
    context: `Run this first:\n\n${block("pwd")}`,
    questions: [{ id: "q1", question: "Done?", detail: `Then:\n\n${block("ls")}\n`, options: [{ value: "y", label: "Yes" }] }],
    ...extra,
  };
}

async function mount(open: PendingAskUser, withSession = true): Promise<AskUserCard> {
  const card = new AskUserCard();
  card.ask = open;
  card.draftSessionId = "local:s1";
  if (withSession) card.ownerRunSession = session;
  document.body.append(card);
  await card.updateComplete;
  return card;
}

/** The Review button of the formatted text inside `host` (a question's detail, or the block drawn in the context editor). */
async function reviewButton(text: LitElement | null): Promise<HTMLButtonElement | null> {
  if (text === null) return null;
  await settleDeferredContent(text);
  await settleDeferredContent(text);
  return text.renderRoot.querySelector<HTMLButtonElement>(".owner-run-button");
}

it("a question detail's pi-run block runs through the Chat's Review dialog, named by the open set", async () => {
  const ownerRun = vi.spyOn(sessionsApi, "ownerRun").mockResolvedValue({ status: "started" });
  const card = await mount(ask());
  const button = await reviewButton(card.renderRoot.querySelector<LitElement>("formatted-text.question-detail"));
  expect(button?.textContent).toBe("Review command…");
  button?.click();
  const dialog = document.querySelector<OwnerRunDialog>("owner-run-dialog");
  await dialog?.updateComplete;
  expect(dialog?.renderRoot.querySelector(".command")?.textContent).toBe("ls");
  dialog?.renderRoot.querySelector<HTMLButtonElement>(".run")?.click();
  await vi.waitFor(() => {
    expect(ownerRun).toHaveBeenCalledWith(session.session, { askId: "ask-1" }, { mode: "run", cwd: "/work/repo", command: "ls" }, "local");
  });
});

it("the context editor draws the agent's pi-run block with its Review button; an edited command or a user-supplied context gets none", async () => {
  const card = await mount(ask());
  const editor = (): AskMarkdownField => {
    const field = card.renderRoot.querySelector<AskMarkdownField>(".context-editor");
    if (field === null) throw new Error("expected the context editor");
    return field;
  };
  const drawn = () => editor().querySelector<LitElement>(".lp-fence-block formatted-text");
  const button = await reviewButton(drawn());
  expect(button?.textContent).toBe("Review command…");
  // The editor keeps a mousedown on the button for the button, so the block stays drawn and the click reaches it.
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true });
  button?.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
  button?.click();
  const dialog = document.querySelector<OwnerRunDialog>("owner-run-dialog");
  await dialog?.updateComplete;
  expect(dialog?.renderRoot.querySelector(".command")?.textContent).toBe("pwd");
  dialog?.remove();

  // Thomas edits the command: the block still draws, as plain code, since the agent never proposed it.
  editor().value = `Run this first:\n\n${block("rm -rf ~")}`;
  const edited = drawn();
  expect(edited).not.toBeNull();
  expect(await reviewButton(edited)).toBeNull();

  // A context the user's edit supplied (a partial send) is not the agent's: no button even unedited.
  document.body.replaceChildren();
  const supplied = await mount(ask({ contextEdited: true }));
  const field = supplied.renderRoot.querySelector<AskMarkdownField>(".context-editor");
  expect(await reviewButton(field?.querySelector<LitElement>(".lp-fence-block formatted-text") ?? null)).toBeNull();
});

it("without this machine's Chat (another machine), pi-run blocks stay plain code", async () => {
  const card = await mount(ask(), false);
  expect(await reviewButton(card.renderRoot.querySelector<LitElement>("formatted-text.question-detail"))).toBeNull();
  // The context keeps its source in the editor, as before.
  expect(card.renderRoot.querySelector(".context-editor .lp-fence-block")).toBeNull();
});

it("a context fence indented as Markdown allows keeps its Review button and runs the command the Chat and server read", async () => {
  const ownerRun = vi.spyOn(sessionsApi, "ownerRun").mockResolvedValue({ status: "started" });
  // One space before each line: the Chat and the server read the command as "echo hi", without the space.
  const card = await mount(ask({ context: `Run this first:\n\n \`\`\`pi-run cwd="/work/repo"\n echo hi\n \`\`\`\n` }));
  const field = card.renderRoot.querySelector<AskMarkdownField>(".context-editor");
  const button = await reviewButton(field?.querySelector<LitElement>(".lp-fence-block formatted-text") ?? null);
  expect(button?.textContent).toBe("Review command…");
  button?.click();
  const dialog = document.querySelector<OwnerRunDialog>("owner-run-dialog");
  await dialog?.updateComplete;
  expect(dialog?.renderRoot.querySelector(".command")?.textContent).toBe("echo hi");
  dialog?.renderRoot.querySelector<HTMLButtonElement>(".run")?.click();
  await vi.waitFor(() => {
    expect(ownerRun).toHaveBeenCalledWith(session.session, { askId: "ask-1" }, { mode: "run", cwd: "/work/repo", command: "echo hi" }, "local");
  });
});
