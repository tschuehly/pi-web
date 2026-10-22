import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { DURABLE_HOST_PROTOCOL, DurableChatService, type DurableHostProcess } from "./durableChatService.js";
import { durableThinkingLevel, expandPromptTemplate, type DurableChatResourceSet } from "./durableChatResources.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";

// Slice 3 group A: the composer of a Durable Chat (queue edits, attachments and media, thinking levels, `!` shell,
// prompt templates) through PI WEB's Durable service, against a host double that names its capabilities.

const ALL = ["queue.edit", "queue.promote", "attachments", "thinking", "shell"];
const LEGEND = "\n\nImage blocks immediately following this text map in order as follows:\n1. [PIC_1]";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const base = { persisted: true, isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], messageCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
interface Request { id: number; method: string; params?: Record<string, unknown> }

function isRequest(value: unknown): value is Request {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "number" && "method" in value && typeof value.method === "string";
}

class FakeHost extends EventEmitter implements DurableHostProcess {
  readonly requests: Request[] = [];
  answer: (request: Request) => unknown = () => base;

  constructor(capabilities: string[] | undefined) {
    super();
    queueMicrotask(() => { this.emit("message", { ready: { protocol: DURABLE_HOST_PROTOCOL, ...(capabilities === undefined ? {} : { capabilities }) } }); });
  }

  send(message: unknown): boolean {
    if (!isRequest(message)) throw new Error("not a host request");
    const request = message;
    this.requests.push(request);
    queueMicrotask(() => {
      const result = this.answer(request);
      if (result instanceof Error) this.emit("message", { id: request.id, error: { message: result.message } });
      else this.emit("message", { id: request.id, result: result ?? null });
      if (request.method === "close") this.emit("exit", 0, null);
    });
    return true;
  }

  push(event: object): void { this.emit("message", { event }); }
  kill(): boolean { this.emit("exit", null, "SIGTERM"); return true; }
  sent(method: string): Request[] { return this.requests.filter((request) => request.method === method); }
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function chat(options: { capabilities?: string[] | undefined; resources?: DurableChatResourceSet } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-durable-composer-"));
  roots.push(root);
  const cwd = join(root, "work");
  await mkdir(cwd);
  const hub = new SessionEventHub();
  const hosts: FakeHost[] = [];
  const { resources } = options;
  const durable = new DurableChatService({
    locator: new SessionRuntimeLocator(root),
    events: hub,
    launch: () => { const launched = new FakeHost("capabilities" in options ? options.capabilities : ALL); hosts.push(launched); return launched; },
    storesDir: join(root, "durable"),
    ...(resources === undefined ? {} : { resources: () => Promise.resolve(resources) }),
  });
  const session = await durable.start(cwd);
  const [host] = hosts;
  if (host === undefined) throw new Error("no host was launched");
  return { durable, hub, host, ref: { id: session.id, cwd }, root };
}

describe("Durable Chat composer", () => {
  it("blocks every composer operation visibly when the host does not name it, and disables the queue controls", async () => {
    const { durable, ref } = await chat({ capabilities: undefined });
    const expectedQueue = [{ kind: "followUp" as const, text: "x" }];
    await expect(durable.mutateQueueMessage(ref, { action: "remove", index: 0, expectedQueue })).rejects.toThrow("Editing a queued message is not available in Durable Chats yet");
    await expect(durable.promoteQueuedMessage(ref, { kind: "followUp", text: "x" })).rejects.toThrow("Promoting queued messages is not available");
    await expect(durable.setThinkingLevel(ref, "high")).rejects.toThrow("Changing the thinking level is not available");
    await expect(durable.shell(ref, "!ls")).rejects.toThrow("Shell commands is not available");
    await expect(durable.prompt(ref, "see", undefined, [{ kind: "image", mimeType: "image/png", data: PNG }])).rejects.toThrow("Attachments is not available");
    await expect(durable.availableThinkingLevels(ref)).resolves.toEqual([]);
    expect((await durable.status(ref)).queueMessageActionsUnavailable).toMatch(/not available/);
  });

  it("maps recall, remove and toggle to the host against the exact queued IDs the browser saw; a stale snapshot is refused", async () => {
    const { durable, host, ref } = await chat();
    const queued = [{ id: 7, kind: "steer", text: "s1" }, { id: 5, kind: "followUp", text: `look [PIC_1]${LEGEND}`, hasAttachments: true, attachmentCount: 1 }, { id: 6, kind: "followUp", text: "f2" }];
    host.answer = (request) => request.method === "status" ? { ...base, queuedMessages: queued } : null;
    const status = await durable.status(ref);
    expect(status.queuedMessages).toEqual([{ kind: "steer", text: "s1" }, { kind: "followUp", text: "look [PIC_1]", hasAttachments: true, attachmentCount: 1 }, { kind: "followUp", text: "f2" }]);
    expect(status.queueMessageActionsUnavailable).toBeUndefined();
    await durable.mutateQueueMessage(ref, { action: "edit", index: 1, expectedQueue: status.queuedMessages });
    await durable.mutateQueueMessage(ref, { action: "toggle", index: 0, expectedQueue: status.queuedMessages });
    await expect(durable.mutateQueueMessage(ref, { action: "remove", index: 0, expectedQueue: status.queuedMessages.slice(1) })).rejects.toThrow("Queued messages changed");
    // Recall loses the attachments only when the browser acknowledged them.
    await expect(durable.mutateQueueMessage(ref, { action: "edit", index: 1, expectedQueue: status.queuedMessages.map(({ kind, text }) => ({ kind, text })) })).rejects.toThrow("Queued messages changed");
    const sent = host.sent("mutateQueue").map((request) => request.params ?? {});
    expect(sent.map(({ action, index, expected }) => ({ action, index, expected }))).toEqual([
      { action: "recall", index: 1, expected: [7, 5, 6] },
      { action: "toggle", index: 0, expected: [7, 5, 6] },
    ]);
    expect(sent.every(({ editId }) => typeof editId === "string")).toBe(true);
  });

  it("promotes one follow-up by its text, leaves a steer or an unknown message alone, and sends all follow-ups now", async () => {
    const { durable, host, ref } = await chat();
    host.answer = (request) => request.method === "status" ? { ...base, queuedMessages: [{ id: 3, kind: "steer", text: "s" }, { id: 1, kind: "followUp", text: "a" }, { id: 2, kind: "followUp", text: "b" }] } : null;
    await durable.promoteQueuedMessage(ref, { kind: "followUp", text: "b" });
    await durable.promoteQueuedMessage(ref, { kind: "steer", text: "s" });
    await durable.promoteQueuedMessage(ref, { kind: "followUp", text: "gone" });
    await durable.promoteAllQueuedMessages(ref);
    expect(host.sent("mutateQueue").map((request) => [request.params?.["action"], request.params?.["index"]])).toEqual([["promote", 2], ["promoteAll", 1]]);
  });

  it("sends inline images as Pi resizes them, with the [PIC_n] legend for the model and metadata for the host; the browser never sees the legend", async () => {
    const { durable, host, hub, ref } = await chat();
    await durable.prompt(ref, "look [PIC_1]", "followUp", [{ kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: PNG, name: "shot.png" }], { operationId: "op-1" });
    const [prompt] = host.sent("prompt");
    expect(prompt?.params).toMatchObject({ operationId: "op-1", mode: "followUp", text: `look [PIC_1]${LEGEND}`, attachments: [{ reference: "[PIC_1]", mimeType: "image/png", name: "shot.png" }] });
    expect(prompt?.params?.["images"]).toMatchObject([{ type: "image", mimeType: "image/png" }]);
    const published: unknown[] = [];
    hub.addGlobal({ OPEN: 1, readyState: 1, send: () => undefined, terminate: () => undefined, on: () => undefined });
    const original = hub.publish.bind(hub);
    hub.publish = (sessionId, event, scope) => { published.push(event); original(sessionId, event, scope); };
    host.push({ type: "message.end", message: { role: "user", content: [{ type: "text", text: `look [PIC_1]${LEGEND}` }, { type: "image", mimeType: "image/png", data: PNG }], entryId: "4" } });
    expect(JSON.stringify(published)).not.toContain("Image blocks immediately following");
  });

  it("serves the Chat's transcript images as media and saves file attachments into its workspace", async () => {
    const { durable, host, hub, ref } = await chat();
    const block = { type: "image", mimeType: "image/png", data: PNG };
    host.answer = (request) => request.method === "transcript" ? { messages: [{ role: "user", content: [{ type: "text", text: "pic" }, block], entryId: "1" }], partial: null, status: base } : base;
    const mediaId = hub.mediaIndex.reference(undefined, { ...block })?.mediaId ?? "";
    const media = await durable.media(ref, mediaId);
    expect(media?.mimeType).toBe("image/png");
    expect(media?.data.equals(Buffer.from(PNG, "base64"))).toBe(true);
    await expect(durable.media({ id: ref.id, cwd: "/elsewhere" }, mediaId)).rejects.toThrow("Session not found");
    const [saved] = await durable.saveAttachments(ref, [{ kind: "file", mimeType: "text/plain", data: Buffer.from("notes").toString("base64"), name: "notes.txt" }], "inbox");
    expect(saved?.path).toMatch(/^inbox\/.*notes\.txt$/);
    expect(await readFile(join(ref.cwd, saved?.path ?? ""), "utf8")).toBe("notes");
  });

  it("forwards thinking levels and `!` commands to the host", async () => {
    const { durable, host, ref } = await chat();
    host.answer = (request) => request.method === "thinkingLevels" ? ["off", "low", "high"] : base;
    await expect(durable.availableThinkingLevels(ref)).resolves.toEqual(["off", "low", "high"]);
    await durable.setThinkingLevel(ref, "high");
    await durable.cycleThinkingLevel(ref);
    await durable.shell(ref, "!!git status");
    expect(host.requests.filter((r) => ["setThinkingLevel", "cycleThinkingLevel", "shell"].includes(r.method)).map((r) => [r.method, r.params])).toEqual([
      ["setThinkingLevel", { level: "high" }], ["cycleThinkingLevel", undefined], ["shell", { text: "!!git status" }],
    ]);
  });

  it("lists and expands prompt templates as Pi does: raw arguments for a leading template, other prompts untouched", async () => {
    const skillDir = await mkdtemp(join(tmpdir(), "pi-web-skill-"));
    roots.push(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: tidy\n---\nTidy.\n");
    const { durable, host, ref } = await chat({ resources: {
      resources: { sources: [] },
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      skillList: [{ name: "tidy", filePath: join(skillDir, "SKILL.md"), baseDir: skillDir }],
      promptList: [{ name: "review", description: "Review code", argumentHint: "<path>", content: "Review $1 (all: $@) ${2:-carefully}" }],
    } });
    expect((await durable.commands(ref)).map((command) => [command.name, command.source])).toEqual([["mode", "extension"], ["name", "builtin"], ["review", "prompt"], ["session", "builtin"], ["skill:tidy", "skill"]]);
    await expect(durable.runCommand(ref, '/review src "two words" /skill:tidy')).resolves.toEqual({ type: "done" });
    await durable.prompt(ref, "/review lib");
    await durable.prompt(ref, "/unknown x");
    expect(host.sent("prompt").map((request) => request.params?.["text"])).toEqual([
      "Review src (all: src two words /skill:tidy) two words",
      "Review lib (all: lib) carefully",
      "/unknown x",
    ]);
  });

  it("ports Pi's argument rules exactly", () => {
    const templates = [{ name: "t", content: "[$1][$2][${@:2}][${@:2:1}][$ARGUMENTS][${3:-none}]" }];
    expect(expandPromptTemplate("/t a 'b c' \"\" d", templates)).toBe("[a][b c][b c  d][b c][a b c  d][none]");
    expect(expandPromptTemplate("no slash", templates)).toBe("no slash");
  });

  it("starts a new Chat at the thinking level Pi would pick from the profile's settings", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-web-agent-"));
    roots.push(agentDir);
    expect(durableThinkingLevel(agentDir, agentDir, "anthropic/claude-x")).toBe("medium");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    expect(durableThinkingLevel(agentDir, agentDir, "anthropic/claude-x")).toBe("low");
  });
});
