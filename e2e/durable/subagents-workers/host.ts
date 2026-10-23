// Test-only wrapper: records host IPC and installs the host's existing crash barriers; never replaces its runtime.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]!;
const root = dirname(arg("--cwd"));
const sessionId = arg("--session-id");
const controlPath = join(root, "fleet-control.json");
const control = JSON.parse(readFileSync(controlPath, "utf8")) as { hold?: string; hideRoster?: boolean; receiptFault?: { workerId: string; foreign?: boolean } };
if (control.hold) process.env["PI_DURABLE_HOLD"] = control.hold;
else delete process.env["PI_DURABLE_HOLD"];
writeFileSync(join(root, `fleet-${sessionId}.pid.json`), JSON.stringify({ pid: process.pid, store: arg("--store"), sessionId }));
const original = process.send!.bind(process);
process.send = ((message: unknown, ...args: unknown[]) => {
  const wire = control.hideRoster ? JSON.parse(JSON.stringify(message, (key, value: unknown) => key === "pi-workbench:activity" ? undefined : value)) : message;
  appendFileSync(join(root, `fleet-${sessionId}.jsonl`), `${JSON.stringify(wire)}\n`);
  return Reflect.apply(original, process, [wire, ...args]);
}) as NonNullable<typeof process.send>;
const hostEntry = pathToFileURL(process.env["DURABLE_FLEET_HOST"]!);
if (control.receiptFault) {
  // Given-fixture for receipt loss / foreign ownership. Open the CLOSED store through the pinned public host API,
  // seed only delegation documents, then close before the real IPC host opens it. No second writer, no resumed work.
  const { openChatHost } = await import(new URL("./chat.ts", hostEntry).href);
  const { WorkersDoc, DelegationDoc } = await import(new URL("./delegation.ts", hostEntry).href);
  const { context } = await import(new URL("./host.ts", hostEntry).href);
  const h = await openChatHost({ dir: arg("--store"), cwd: arg("--cwd"), model: "faux", chatId: sessionId });
  try {
    await h.root.commit(async (tx: { doc: (definition: unknown, conversation?: number) => Promise<Record<string, Record<string, Record<string, unknown>>>> }) => {
      const worker = (await tx.doc(WorkersDoc))["workers"]![control.receiptFault!.workerId]!;
      if (control.receiptFault!.foreign) worker["ownerConversationId"] = Number(worker["ownerConversationId"]) + 10000;
      else {
        const receipts = worker["receipts"] as Record<string, unknown>[];
        const latest = receipts.at(-1)!;
        const diagnostic = "Fixture receipt acknowledgement lost; inspection required.";
        latest["outcome"] = "outcome_unknown";
        latest["diagnostic"] = diagnostic;
        worker["requiresInspection"] = { at: new Date().toISOString(), diagnostic };
        const execution = (await tx.doc(DelegationDoc, h.root.id))["executions"]![String(latest["executionId"])]!;
        Object.assign(execution, { outcome: "outcome_unknown", diagnostic, collected: false });
      }
    }, context);
  } finally { await h.close(); }
  delete control.receiptFault;
  writeFileSync(controlPath, JSON.stringify(control));
}
await import(hostEntry.href);
