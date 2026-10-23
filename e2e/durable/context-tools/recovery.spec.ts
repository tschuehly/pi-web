/** AC-P051 AC-P069: actual SIGKILL after a FIFO write effect, never a browser-only reconnect. */
import { execFileSync, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, mock, root, createChat, send, chat, status, messages, killHost, idle } from "./support";

test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(60_000);

for (const resolution of ["Done", "Not done", "Retry"] as const) {
  test(`AC-P051 interrupted external write resolved ${resolution} without implicit replay`, async ({ page }) => {
    const fifo = join(root(), `unsafe-${Date.now()}.fifo`);
    const effects = `${fifo}.effects`;
    execFileSync("mkfifo", [fifo]);
    // The reader acknowledges the first externally visible effect, then stops consuming. The > pipe-capacity write
    // remains in progress: SIGKILL is after effect, before the unsafe tool result can commit.
    const receiver = spawn("python3", ["-c", "import os,sys,signal\nf=os.open(sys.argv[1],os.O_RDONLY)\nb=os.read(f,6)\nopen(sys.argv[2],'ab').write(b+b'\\n')\nsignal.pause()", fifo, effects], { stdio: "ignore" });
    try {
      await mock.script({ turns: [[{ toolCall: { name: "write", args: { path: fifo, content: "effect" + "x".repeat(256_000) } } }],
        ...(resolution === "Done" ? [[{ toolCall: { name: "write", args: { path: fifo, content: "duplicate must not run" } } }], "Duplicate blocked.", "After duplicate attempt."] : []),
        ...(resolution === "Retry" ? ["Interrupted run reconciled.", [{ toolCall: { name: "write", args: { path: fifo, content: "authorized retry" } } }]] : []), "Reconciliation acknowledged."] });
      const id = await createChat(page);
      await send(page, "unsafe fixture write");
      await expect.poll(() => readFile(effects, "utf8").catch(() => "")).toBe("effect\n");
      await expect(chat(page).locator("tool-execution-view .tool-card.running")).toHaveCount(1);
      await killHost(page, id);
      const card = chat(page).locator(".unresolved-effects");
      await expect(card).toContainText("Needs reconciliation");
      expect((await status(page, id)).unresolvedEffects).toHaveLength(1);
      await messages(page, id);
      await page.reload();
      await expect(card).toBeVisible();
      expect(await readFile(effects, "utf8")).toBe("effect\n");
      expect(await mock.journal({ kind: "chat" })).toHaveLength(1);
      // Remove the blocked FIFO only after the host is dead. A retry can now safely write to a regular test file.
      receiver.kill("SIGKILL");
      await rm(fifo);
      if (resolution === "Done") {
        await send(page, "try a fresh duplicate write");
        await expect(chat(page).getByText("After duplicate attempt.", { exact: true })).toBeVisible();
        await idle(page, id);
        expect(await readFile(fifo, "utf8").catch(() => undefined)).toBeUndefined();
        expect((await status(page, id)).unresolvedEffects).toHaveLength(1);
      }
      await card.getByRole("button", { name: resolution, exact: true }).click();
      await expect(card).toHaveCount(0);
      await expect(chat(page).getByText(/The user resolved the interrupted write call/).first()).toBeVisible();
      if (resolution === "Retry") await expect(chat(page).getByText("Reconciliation acknowledged.", { exact: true })).toBeVisible();
      await idle(page, id);
      await killHost(page, id);
      await expect(card).toHaveCount(0);
      expect(await readFile(effects, "utf8")).toBe("effect\n");
      // Resolution alone must not silently retry. Retry is the only resolution allowed to produce another file.
      const exists = await readFile(fifo, "utf8").catch(() => undefined);
      if (resolution !== "Retry") expect(exists).toBeUndefined();
      else expect(exists, "Only the explicitly authorized model retry can run").toBe("authorized retry");
    } finally {
      receiver.kill("SIGKILL");
      await rm(fifo, { force: true });
    }
  });
}
