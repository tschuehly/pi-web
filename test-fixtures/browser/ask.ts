import type { PendingAskUser } from "../../src/shared/apiTypes";
import { WorkbenchQuestionChips } from "../../src/client/src/components/WorkbenchQuestionChips";

const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-surface-hover: #333; --pi-text: #eee; --pi-border: #555; --pi-muted: #aaa; --pi-accent: #aaf; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  .pane { display: flex; flex-direction: column; height: 90vh; width: 720px; }
`;
document.head.append(style);

const ask: PendingAskUser = {
  askId: "ask-copy",
  askedAt: "2026-11-21T00:00:00Z",
  updatedAt: "2026-11-21T00:00:00Z",
  revision: "r1",
  turnsSinceUpdate: 0,
  context: "Context prose to copy, with `inline-code-copy` in it.\n\n```sh\necho copied-command\n```\n\nAfter the block.",
  questions: [
    {
      id: "q1",
      question: "Question line to copy?",
      detail: "Question detail to copy.",
      options: [
        { value: "a", label: "Option label to copy", detail: "Option detail to copy", recommended: true },
        { value: "b", label: "Other option" },
      ],
    },
  ],
};
const pane = document.createElement("div");
pane.className = "pane";
const chips = new WorkbenchQuestionChips();
chips.asks = [ask];
chips.draftSessionId = "ask-fixture";
pane.append(chips);
document.body.append(pane);
await chips.updateComplete;
await chips.openQuestion(ask.askId, 0);
document.body.dataset["ready"] = "true";
