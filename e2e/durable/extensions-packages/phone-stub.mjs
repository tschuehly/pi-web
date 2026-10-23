// No network imports: the real ping-a-human-pi extension talks only to this stdio stub.
import { appendFileSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { createInterface } from "node:readline";
const [log, replies] = process.argv.slice(2);
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const pending = new Map();
const flush = () => {
  const values = JSON.parse(readFileSync(replies, "utf8"));
  for (const [id, key] of pending) if (values[key]) {
    pending.delete(id); send(id, { content: [{ type: "text", text: values[key] }] });
  }
};
watchFile(replies, { interval: 50 }, flush);
const input = createInterface({ input: process.stdin });
input.on("close", () => { unwatchFile(replies); process.exit(0); });
input.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fleet-phone-stub", version: "1" } });
  if (method === "tools/list") send(id, { tools: ["ask_human", "notify_human"].map((name) => ({ name, description: "Fixture phone only", inputSchema: { type: "object", properties: { message: { type: "string" } } } })) });
  if (method !== "tools/call") return;
  appendFileSync(log, `${JSON.stringify({ name: params.name, args: params.arguments, transport: "stdio-fixture" })}\n`);
  const key = params.arguments.question ?? params.arguments.message;
  if (key.startsWith("hold:")) { pending.set(id, key); flush(); }
  else if (key.startsWith("fail:")) send(id, { isError: true, content: [{ type: "text", text: "Fixture transport refused" }] });
  else if (key.startsWith("timeout:")) send(id, { isError: true, content: [{ type: "text", text: "Fixture reply timed out" }] });
  else send(id, { content: [{ type: "text", text: params.name === "ask_human" ? "fixture yes" : "fixture delivered" }] });
});
