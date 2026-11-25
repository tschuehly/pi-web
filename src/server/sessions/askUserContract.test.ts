import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AskUserQuestion } from "../../shared/apiTypes.js";
import { createAskUserToolDefinition } from "./askUserTool.js";
import { PendingAskStore } from "./pendingAskStore.js";
import { stubExtensionToolContext } from "./piSessionService.testSupport.js";

// The same fixture checks the Durable host's copy: pi-workbench packages/durable-pilot/test/ask-user-contract.test.ts.
interface Fixture {
  valid: { input: { context: string; questions: AskUserQuestion[] }; expected: { context: string; questions: unknown[] } };
  invalid: { name: string; questions: AskUserQuestion[]; error: string }[];
  approval: { accepted: [boolean | null, true | null][]; invalid: { value: unknown; error: string } };
}
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the fixture file is this test's own input.
const fixture = JSON.parse(readFileSync(new URL("./askUserContract.fixture.json", import.meta.url), "utf8")) as Fixture;

/** Posts through the tool's `toQuestion` into a real store's validation, the path every PI WEB ask takes. */
async function post(context: string, questions: AskUserQuestion[], approval?: unknown) {
  const store = new PendingAskStore({ createAskId: () => "abc-1" });
  const tool = createAskUserToolDefinition({
    open: (input) => Promise.resolve(store.open(input)),
    update: () => Promise.resolve(undefined),
    withdraw: () => Promise.resolve(undefined),
  });
  const ctx = stubExtensionToolContext({ sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined } });
  await tool.execute("call-1", { context, questions, ...(approval === undefined ? {} : { approval }) }, undefined, undefined, ctx);
  return store.pendingAsks("session-1")[0];
}

describe("ask_user question rules contract", () => {
  it("keeps every supported field and drops unknown ones, as the Durable host does", async () => {
    const ask = await post(fixture.valid.input.context, fixture.valid.input.questions);

    expect(ask?.context).toBe(fixture.valid.expected.context);
    expect(ask?.questions).toStrictEqual(fixture.valid.expected.questions);
  });

  it.each(fixture.invalid)("rejects $name with the host's message", async ({ questions, error }) => {
    await expect(post("c", questions)).rejects.toThrow(error);
  });

  it("keeps approval true, drops false, and rejects other values with the host's message", async () => {
    for (const [given, kept] of fixture.approval.accepted) expect((await post("c", fixture.valid.input.questions, given ?? undefined))?.approval).toBe(kept ?? undefined);
    await expect(post("c", fixture.valid.input.questions, fixture.approval.invalid.value)).rejects.toThrow(fixture.approval.invalid.error);
  });
});
