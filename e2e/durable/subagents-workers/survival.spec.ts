// AC-P089–AC-P099 survival: SIGKILL at the five existing host commit/delivery barriers, not a browser reconnect.
import { writeFile } from "node:fs/promises";
import { control, create, expect, held, killHost, messages, mock, requests, scout, send, status, tc, test, textOf, call } from "./support";

for (const kind of ["subagent", "worker"] as const) for (const barrier of ["child:before-admission", "child:after-result", "child:before-delivery", "child:after-delivery", "collect:after-commit"]) {
  test(`AC-P089 AC-P090 AC-P095 AC-P096 AC-P097 AC-P099 SIGKILL ${kind} ${barrier}: one assignment, wake and collection`, async ({ page }) => {
    test.setTimeout(90_000);
    await control({ hold: barrier });
    await create(page);
    let workerId: string | undefined;
    if (kind === "worker") {
      await call(page, "tools_enable", { group: "workers" });
      workerId = String((await call(page, "worker_create", { name: "Survivor", scope: "recovery", profile: "scout" })).details!["workerId"]);
    }
    const marker = `survival-lead-${Date.now()}`;
    const child = `survival-child-${Date.now()}`;
    const childScript = await mock.script({ provider: "openai-codex", match: child, turns: [[tc("report_status", { status: "Survival status retained" })], "Survival result."] });
    const leadScript = await mock.script({ provider: "anthropic", match: marker, turns: [
      [kind === "subagent" ? tc("subagent", scout(child)) : tc("worker_dispatch", { workerId, task: child, cognitiveRole: "routine", background: true })], "Background launched.",
      [tc("subagent_collect")], "Collection checked.",
      [tc("subagent_collect")], "Collection checked again.",
      [tc("subagent_collect")], "Final collection checked.",
    ] });
    await send(page, marker);
    await held(page, barrier);
    await control();
    const killed = await killHost(page);
    await status(page); // Opens the same store paused; read-only requests must not schedule work.
    await page.reload();
    const before = (await mock.journal()).length;
    for (let n = 0; n < 3; n++) {
      await status(page);
      await messages(page);
    }
    expect((await mock.journal()).length).toBe(before);
    await writeFile(test.info().outputPath("killed-host.json"), JSON.stringify({ ...killed, barrier }));
    await send(page, "Resume and reconcile the committed child.");
    await expect.poll(async () => (await messages(page)).filter((m) => m.toolName === "subagent_collect" && textOf(m).includes("Survival result.")).length, { timeout: 45_000 }).toBe(1);
    await expect.poll(async () => (await status(page)).isStreaming).toBe(false);
    const transcript = await messages(page);
    expect(transcript.filter((m) => m.toolName === (kind === "subagent" ? "subagent" : "worker_dispatch"))).toHaveLength(1);
    expect(transcript.filter((m) => m.customType === "pi-workbench:child-completion")).toHaveLength(1);
    expect(await requests(childScript)).toHaveLength(2);
    expect((await requests(leadScript)).every((r) => r.violations.length === 0)).toBe(true);
    await mock.removeScript(leadScript);
    await page.reload();
    expect(textOf(await call(page, "subagent_collect"))).toContain("Nothing terminal to reconcile");
    const retained = await call(page, "subagent_status", { all: true });
    expect(textOf(retained)).toContain("0 running, 0 terminal and uncollected, 1 launched");
    if (workerId) {
      const receipt = (await call(page, "worker_status", { workerId })).details!["worker"] as { receipts: unknown[]; lineage: number[]; lock: unknown };
      expect(receipt.receipts).toHaveLength(1);
      expect(receipt.lineage).toHaveLength(1);
      expect(receipt.lock).toBeNull();
    }
    expect(textOf(retained)).toContain("Survival status retained");
    expect(await requests(childScript)).toHaveLength(2);
    await writeFile(test.info().outputPath("counts.json"), JSON.stringify({
      kind, barrier, childRequests: (await requests(childScript)).length,
      assignments: transcript.filter((m) => m.toolName === (kind === "subagent" ? "subagent" : "worker_dispatch")).length,
      wakes: transcript.filter((m) => m.customType === "pi-workbench:child-completion").length,
      collections: transcript.filter((m) => m.toolName === "subagent_collect" && textOf(m).includes("Survival result.")).length,
    }, null, 2));
  });
}
