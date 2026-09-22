// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import { normalizeMessage } from "../chatMessages";
import type { FormattedText } from "./FormattedText";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

it("renders inline skills and surrounding text in order without treating text as HTML", async () => {
  const view = new ChatView();
  view.sessionId = "session";
  view.messages = normalizeMessage({ role: "user", content: 'Before <img src=x onerror=alert(1)> <skill name="a" location="/a">\nOne\n</skill> between <skill name="b" location="/b">\nTwo\n</skill> after' });
  document.body.append(view);
  await view.updateComplete;
  const parts = [...view.renderRoot.querySelectorAll("article.msg.user .part")];
  expect(parts.map((part) => part.tagName.toLowerCase())).toEqual(["formatted-text", "details", "formatted-text", "details", "formatted-text"]);
  expect(parts.filter((part) => part.matches("details")).map((part) => part.querySelector(".disclosure-preview")?.textContent)).toEqual(["[skill] a", "[skill] b"]);
  const textParts = parts.filter((part): part is FormattedText => part.tagName.toLowerCase() === "formatted-text");
  await Promise.all(textParts.map((part) => part.updateComplete));
  expect(textParts[0]?.renderRoot.querySelector("img[src=x]")).toBeNull();
});

it("updates workspace links while keeping orphan tool results literal", async () => {
  const view = new ChatView();
  const text = "[file](result.zip)";
  view.sessionId = "session";
  view.workspaceContext = { machineId: "remote", projectId: "p", workspaceId: "w", root: "/work" };
  view.clientQueuedMessages = [{ kind: "followUp", text }];
  view.messages = [{ role: "assistant", parts: [
    { type: "text", text },
    { type: "thinking", text },
    { type: "skillInvocation", name: "skill", location: "/skill", content: text },
    { type: "toolResult", toolName: "read", text, isError: false },
  ] }];
  document.body.append(view);
  await view.updateComplete;
  for (const details of view.renderRoot.querySelectorAll<HTMLDetailsElement>("details")) {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  }
  await view.updateComplete;

  const orphanResult = view.renderRoot.querySelector("pre.orphan-tool-result");
  expect(orphanResult?.textContent).toBe(text);
  expect(orphanResult?.querySelector("a")).toBeNull();

  async function hrefs() {
    const formatted = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
    expect(formatted).toHaveLength(4);
    await Promise.all(formatted.map((element) => element.updateComplete));
    return formatted.map((element) => element.renderRoot.querySelector("a")?.getAttribute("href"));
  }

  expect((await hrefs()).every((href) => href?.includes("/machines/remote/projects/p/workspaces/w/file/preview?path=result.zip&download=1") === true)).toBe(true);
  view.workspaceContext = { machineId: "other", projectId: "p2", workspaceId: "w2", root: "/other" };
  await view.updateComplete;
  expect((await hrefs()).every((href) => href?.includes("/machines/other/projects/p2/workspaces/w2/") === true)).toBe(true);
  view.workspaceContext = undefined;
  await view.updateComplete;
  expect(await hrefs()).toEqual([null, null, null, null]);
});
