/** AC-P062 codemode and AC-P064 spawn_session in a Durable Chat (cutover B2 rows). */
import { join } from "node:path";
import { test, expect, mock, project, createChat, answer, messages, text, chat, expandTools, fixture, fakeSecret, storeLeaks, url, api } from "./support";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";

test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(90_000);

test("AC-P062 codemode: the lead's script calls the Chat's tools, its result renders, and no secret it read is stored", async ({ page }) => {
  const marker = `codemode-${Date.now()}`;
  await fixture(join(project(), `${marker}.txt`), `codemode-visible-${marker}\nTOKEN=${fakeSecret}\n`);
  const code = `const a = await tools.read({ path: "${marker}.txt" }); return "script saw: " + a;`;
  await mock.script({ match: marker, turns: [[{ toolCall: { name: "codemode", args: { code } } }], "Codemode checks complete."] });
  const id = await createChat(page);
  await answer(page, id, marker, "Codemode checks complete.");
  const result = (await messages(page, id)).find((m) => m.role === "toolResult" && m.toolName === "codemode");
  expect(result?.isError).not.toBe(true);
  expect(text(result?.content)).toContain(`script saw: codemode-visible-${marker}`);
  expect(text(result?.content)).not.toContain(fakeSecret);
  await expandTools(page);
  await expect(chat(page).getByText(`script saw: codemode-visible-${marker}`, { exact: false }).first()).toBeVisible();
  expect(await storeLeaks(id)).toEqual([]);
});

test("AC-P064 spawn_session: the lead starts an independent Durable Chat that answers its prompt and shows in the Chat list", async ({ page }) => {
  const marker = `spawn-${Date.now()}`;
  const childPrompt = `kid-${String(Date.now())}-${String(process.pid)}`; // must not contain the lead's marker
  await mock.script({ match: marker, turns: [[{ toolCall: { name: "spawn_session", args: { prompt: childPrompt } } }], "Spawn checks complete."] });
  await mock.script({ match: childPrompt, turns: ["Child answered."] });
  const id = await createChat(page);
  await answer(page, id, marker, "Spawn checks complete.");
  const result = (await messages(page, id)).find((m) => m.role === "toolResult" && m.toolName === "spawn_session");
  expect(result?.isError, text(result?.content)).not.toBe(true);
  const childId = /Started independent session (\S+) in /.exec(text(result?.content))?.[1];
  expect(childId, text(result?.content)).toBeDefined();
  await expect(
    chat(page)
      .getByText(/Started independent session/)
      .first(),
  ).toBeVisible();
  try {
    await expect
      .poll(async () => (await messages(page, childId!)).some((m) => m.role === "assistant" && text(m.content).includes("Child answered.")))
      .toBe(true);
    const child = (await messages(page, childId!)).find((m) => m.role === "user");
    expect(text(child?.content)).toContain(childPrompt);
    // The spawned Chat is a Durable Chat of the same workspace, listed for the browser.
    await page.goto(
      `${api()}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"]!, session: childId!, view: "chat" })}`,
    );
    await expect(chat(page).getByText("Child answered.", { exact: true }).first()).toBeVisible();
    const listed = await page.request.get(`${api()}api/sessions?${new URLSearchParams({ cwd: project() })}`);
    expect(JSON.stringify(await listed.json())).toContain(childId!);
  } finally {
    if (childId !== undefined) await page.request.post(url(childId, "stop"), { data: { cwd: project() } });
  }
});
