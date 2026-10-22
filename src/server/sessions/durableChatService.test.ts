import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { DURABLE_HOST_PROTOCOL, DurableChatService, durableHostArgs, type DurableHostProcess } from "./durableChatService.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";
import type { DurableChatResourceSet } from "./durableChatResources.js";
import type { PendingAskUser } from "../../shared/apiTypes.js";

const status = { persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], messageCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
interface Request { id: number; method: string; params?: Record<string, unknown> }

function isRequest(value: unknown): value is Request {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "number" && "method" in value && typeof value.method === "string";
}

function only<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined) throw new Error("no host was launched");
  return first;
}

/** A host process double: answers requests through `answer`, pushes events, and exits on demand. */
class FakeHost extends EventEmitter implements DurableHostProcess {
  readonly requests: Request[] = [];
  answer: (request: Request) => unknown = (request) => (request.method === "status" ? status : null);

  constructor(protocol = DURABLE_HOST_PROTOCOL, capabilities?: unknown) {
    super();
    queueMicrotask(() => { this.emit("message", { ready: { protocol, ...(capabilities === undefined ? {} : { capabilities }) } }); });
  }

  send(message: unknown): boolean {
    if (!isRequest(message)) throw new Error("not a host request");
    const request = message;
    this.requests.push(request);
    queueMicrotask(() => {
      try {
        this.emit("message", { id: request.id, result: this.answer(request) });
      } catch (error) {
        this.emit("message", { id: request.id, error: { message: error instanceof Error ? error.message : String(error) } });
      }
      // A real host closes its store, replies, then exits a little later.
      if (request.method === "close") setTimeout(() => { this.emit("exit", 0, null); }, this.exitDelayMs);
    });
    return true;
  }

  exitDelayMs = 0;

  push(event: object): void {
    this.emit("message", { event });
  }

  kill(): boolean {
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type UnreadCall = [sessionId: string, cwd: string, change: "active" | "idle" | "closed"];

async function service(make: (launch: number) => FakeHost = () => new FakeHost(), resources?: DurableChatResourceSet): Promise<{ durable: DurableChatService; hub: SessionEventHub; locator: SessionRuntimeLocator; launched: FakeHost[]; root: string; unread: UnreadCall[] }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-durable-"));
  roots.push(root);
  const hub = new SessionEventHub();
  const locator = new SessionRuntimeLocator(root);
  const launched: FakeHost[] = [];
  const unread: UnreadCall[] = [];
  const durable = new DurableChatService({
    locator,
    events: hub,
    launch: () => { const host = make(launched.length); launched.push(host); return host; },
    storesDir: join(root, "durable"),
    ...(resources === undefined ? {} : { resources: () => Promise.resolve(resources) }),
    unread: (sessionId, cwd, change) => { unread.push([sessionId, cwd, change]); return Promise.resolve(); },
  });
  return { durable, hub, locator, launched, root, unread };
}


describe("Durable Chats", () => {
  it("records a new Chat before its host opens, and lists it under its workspace only", async () => {
    const { durable, locator, root } = await service();
    const chat = await durable.start("/work/a", "token-1");
    expect(chat).toMatchObject({ cwd: "/work/a", startupToken: "token-1", name: "Durable Chat", path: `durable:${chat.id}`, persisted: true });
    expect(locator.durable(chat.id)).toMatchObject({ runtime: "durable", storeId: chat.id });
    expect(durable.list("/work/a").map((session) => session.id)).toEqual([chat.id]);
    expect(durable.list("/work/b")).toEqual([]);
    // The locator survives a daemon restart and stays owner-only.
    expect(new SessionRuntimeLocator(root).durable(chat.id)?.cwd).toBe("/work/a");
    expect((await stat(join(root, "session-runtimes.json"))).mode & 0o777).toBe(0o600);
  });

  it("drops the record when the host never becomes ready, and refuses a host on another protocol", async () => {
    const { durable, locator } = await service(() => new FakeHost(DURABLE_HOST_PROTOCOL + 1));
    await expect(durable.start("/work/a")).rejects.toThrow(/protocol 3, this daemon 2/);
    expect(locator.all()).toEqual([]);
  });

  it("forwards host events with sequence numbers and gives a snapshot the watermark of its reply", async () => {
    const { durable, hub, launched } = await service();
    const chat = await durable.start("/work/a");
    const host = only(launched);
    const ref = { id: chat.id, cwd: chat.cwd };
    host.answer = (request) => {
      // An event the host sent before its reply is published before the reply resolves.
      if (request.method === "transcript") host.push({ type: "assistant.delta", text: "late", streamId: "s1" });
      return { messages: [{ role: "user", content: "hi", entryId: "8" }], partial: { role: "assistant", content: [], streamId: "s1" }, status };
    };
    host.push({ type: "agent.start" });
    const snapshot = await durable.transcriptSnapshot(ref);
    // agent.start, its activity.update, and the delta.
    expect(snapshot.seq).toBe(hub.currentSeq(chat.id));
    expect(snapshot.seq).toBe(3);
    expect(snapshot.page).toEqual({ messages: [{ role: "user", content: "hi", entryId: "8" }], start: 0, total: 1 });
    expect(snapshot.status.sessionId).toBe(chat.id);
  });

  it("adds the Chat id to host status, publishes it globally and keeps the listing's first message", async () => {
    const { durable, hub, launched, locator } = await service();
    const chat = await durable.start("/work/a");
    const global: unknown[] = [];
    hub.addGlobal({ OPEN: 1, readyState: 1, send: (payload) => { global.push(JSON.parse(payload)); }, terminate: () => undefined, on: () => undefined });
    only(launched).push({ type: "message.end", message: { role: "user", content: "Fix the build", entryId: "8" } });
    only(launched).push({ type: "status.update", status: { ...status, messageCount: 1 } });
    // A host that names no queue capability (slice 2) gets its queue controls disabled with a reason.
    expect(global.find((event) => typeof event === "object" && event !== null && "type" in event && event.type === "status.update")).toMatchObject({ status: { ...status, messageCount: 1, sessionId: chat.id, capabilities: [], queueMessageActionsUnavailable: "Editing queued messages is not available in this Durable Chat host yet." } });
    expect(locator.durable(chat.id)).toMatchObject({ firstMessage: "Fix the build", messageCount: 1 });
    expect(durable.list("/work/a")[0]?.name).toBe("Durable · Fix the build");
  });

  it("sends each prompt under its own operation id and rejects attachments", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await durable.prompt(ref, "first");
    await durable.prompt(ref, "second", "followUp");
    const prompts = only(launched).requests.filter((request) => request.method === "prompt");
    expect(prompts.map((request) => request.params?.["text"])).toEqual(["first", "second"]);
    expect(prompts[1]?.params?.["mode"]).toBe("followUp");
    expect(new Set(prompts.map((request) => request.params?.["operationId"])).size).toBe(2);
    await expect(durable.prompt(ref, "with image", undefined, [{ kind: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }])).rejects.toThrow(/Attachments is not available in Durable Chats yet/);
    await expect(durable.prompt({ id: chat.id, cwd: "/elsewhere" }, "x")).rejects.toThrow("Session not found");
  });

  it("fails pending requests when the host exits and starts a fresh host on the next use", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const first = only(launched);
    first.send = () => { queueMicrotask(() => first.kill()); return true; };
    await expect(durable.status(ref)).rejects.toThrow(/Durable host exited \(SIGTERM\)/);
    await expect(durable.status(ref)).resolves.toMatchObject({ sessionId: chat.id });
    expect(launched).toHaveLength(2);
  });

  it("sends the workspace's resources before the first request and expands /skill: prompts as Pi does", async () => {
    const skillDir = await mkdtemp(join(tmpdir(), "pi-web-skill-"));
    roots.push(skillDir);
    const filePath = join(skillDir, "SKILL.md");
    await writeFile(filePath, "---\nname: tidy\ndescription: Tidy up\n---\nTidy every file.\n");
    const { durable, launched } = await service(undefined, {
      resources: { projectContext: "Project-specific instructions and guidelines:", sources: [] },
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      skillList: [{ name: "tidy", filePath, baseDir: skillDir, description: "Tidy up" }],
    });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    expect(only(launched).requests[0]).toMatchObject({ method: "configure", params: {
      resources: { projectContext: "Project-specific instructions and guidelines:" },
      // Pi's compaction settings: the host compacts like a legacy Chat.
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    } });
    await expect(durable.commands(ref)).resolves.toEqual([
      expect.objectContaining({ name: "mode", source: "extension" }),
      expect.objectContaining({ name: "name", source: "builtin" }),
      expect.objectContaining({ name: "session", source: "builtin" }),
      { name: "skill:tidy", description: "Tidy up", source: "skill" },
    ]);
    await durable.prompt(ref, "/skill:tidy src only", undefined, undefined, { operationId: "op-7" });
    const prompt = only(launched).requests.find((request) => request.method === "prompt");
    expect(prompt?.params).toEqual({ operationId: "op-7", text: `<skill name="tidy" location="${filePath}">\nReferences are relative to ${skillDir}.\n\nTidy every file.\n</skill>\n\nsrc only` });
  });

  it("runs /mode in the host and refuses other commands visibly", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => request.method === "mode" ? { type: "done", message: "Working Mode applies with the next prompt." }
      : request.method === "command" ? { type: "unsupported", message: `/${String(request.params?.["name"])} is not available in Durable Chats yet` } : status;
    await expect(durable.runCommand(ref, "/mode attention focused")).resolves.toEqual({ type: "done", message: "Working Mode applies with the next prompt." });
    expect(only(launched).requests.find((request) => request.method === "mode")?.params).toEqual({ args: "attention focused" });
    await expect(durable.runCommand(ref, "/tree")).resolves.toEqual({ type: "unsupported", message: "/tree is not available in Durable Chats yet" });
  });

  it("offers and runs /compact only when the host reports the compact capability", async () => {
    const { durable, launched } = await service((launch) => new FakeHost(DURABLE_HOST_PROTOCOL, launch === 0 ? ["compact", "tool-groups"] : []));
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => request.method === "compact" ? { type: "done" } : status;
    expect((await durable.status(ref)).capabilities).toEqual(["compact", "tool-groups"]);
    expect((await durable.commands(ref)).map((command) => command.name)).toEqual(["compact", "mode", "name", "session"]);
    await expect(durable.runCommand(ref, "/compact Keep the test names")).resolves.toEqual({ type: "done" });
    await expect(durable.runCommand(ref, "/compact")).resolves.toEqual({ type: "done" });
    expect(only(launched).requests.filter((request) => request.method === "compact").map((request) => request.params)).toEqual([{ instructions: "Keep the test names" }, {}]);

    // An older host without the capability: no /compact command, and running it is refused visibly.
    await durable.stop(ref);
    expect((await durable.commands(ref)).map((command) => command.name)).toEqual(["mode", "name", "session"]);
    await expect(durable.runCommand(ref, "/compact")).resolves.toEqual({ type: "unsupported", message: "/compact is not available in this Durable Chat's host" });
    expect(launched[1]?.requests.some((request) => request.method === "compact")).toBe(false);
  });

  it("runs pi-openai-fast-mode's /fast through the host's command dispatcher, with its usage error visible", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => {
      if (request.method === "commands") return [{ name: "fast", description: "Toggle Fast Mode. Usage: /fast [on|off|toggle]" }];
      if (request.method !== "command") return status;
      return request.params?.["args"] === "on" ? { type: "done", message: "Fast Mode on" } : { type: "unsupported", message: "Usage: /fast [on|off|toggle]" };
    };
    expect(await durable.commands(ref)).toEqual(expect.arrayContaining([{ name: "fast", description: "Toggle Fast Mode. Usage: /fast [on|off|toggle]", source: "extension" }]));
    await expect(durable.runCommand(ref, "/fast on")).resolves.toEqual({ type: "done", message: "Fast Mode on" });
    await expect(durable.runCommand(ref, "/fast maybe")).resolves.toEqual({ type: "unsupported", message: "Usage: /fast [on|off|toggle]" });
    expect(only(launched).requests.filter((request) => request.method === "command").map((request) => request.params)).toMatchObject([{ name: "fast", args: "on" }, { name: "fast", args: "maybe" }]);
  });

  it("lists and runs installed Pi package commands in the host; a refused one keeps the host's reason (P118 P126 P134)", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => {
      if (request.method === "commands") return [{ name: "ping", description: "Send a Telegram notification" }, { name: "monitors" }];
      if (request.method === "command") return request.params?.["name"] === "google-account"
        ? { type: "unsupported", message: "/google-account is not available in Durable Chats: deferred" }
        : { type: "done" };
      return status;
    };
    const commands = await durable.commands(ref);
    expect(commands).toEqual(expect.arrayContaining([
      { name: "ping", description: "Send a Telegram notification", source: "extension" },
      { name: "monitors", source: "extension" },
    ]));
    expect(commands.map((command) => command.name)).toEqual(["mode", "monitors", "name", "ping", "session"]);
    await expect(durable.runCommand(ref, "/ping deploy done")).resolves.toEqual({ type: "done" });
    expect(only(launched).requests.find((request) => request.method === "command")?.params).toMatchObject({ name: "ping", args: "deploy done" });
    await expect(durable.runCommand(ref, "/google-account")).resolves.toEqual({ type: "unsupported", message: "/google-account is not available in Durable Chats: deferred" });
  });

  it("starts every Durable Chat host with the installed Pi packages", () => {
    expect(durableHostArgs({ id: "c1", cwd: "/work/a" }, "/stores/s1", { model: "faux" })).toContain("--packages");
    expect(durableHostArgs({ id: "c1", cwd: "/work/a" }, "/stores/s1", { model: "faux", thinking: "high" })).toEqual(expect.arrayContaining(["--packages", "--thinking", "high"]));
  });

  it("validates answers with PI WEB's ask store and has the host commit them under the client's operation id", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, context: "Pick", questions: [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }] };
    let open = true;
    only(launched).answer = (request) => {
      if (request.method === "closeAsk") {
        const params = request.params ?? {};
        if (!open || params["revision"] !== "r1") return { result: "stale" };
        open = false;
        return { result: "closed", outcome: params["outcome"] };
      }
      return { ...status, ...(open ? { pendingAsks: [ask] } : {}) };
    };
    await expect(durable.submitAsk(ref, "ask-1", { answers: [{ id: "db", values: ["mysql"] }], revision: "r1" })).rejects.toThrow("Question db has no option mysql");
    const closed = await durable.submitAsk(ref, "ask-1", { answers: [{ id: "db", values: ["pg"] }], revision: "r1" }, "op-a");
    expect(closed).toMatchObject({ result: "closed", outcome: { askId: "ask-1", reason: "submitted", answeredCount: 1 } });
    const sent = only(launched).requests.filter((request) => request.method === "closeAsk");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toMatchObject({ askId: "ask-1", operationId: "op-a", revision: "r1" });
    expect(String(sent[0]?.params?.["content"])).toContain("The user submitted answers to question set ask-1.");
    // The ask is gone now: PI WEB's store sees a stale close, the host decides (its retry receipt, or stale).
    await expect(durable.submitAsk(ref, "ask-1", { answers: [], revision: "r1" }, "op-b")).resolves.toMatchObject({ result: "stale" });
  });

  it("turns a host attention signal into one global session.attention event", async () => {
    const { durable, hub, launched } = await service();
    const chat = await durable.start("/work/a");
    const global: unknown[] = [];
    hub.addGlobal({ OPEN: 1, readyState: 1, send: (payload) => { global.push(JSON.parse(payload)); }, terminate: () => undefined, on: () => undefined });
    only(launched).push({ type: "durable.attention", kind: "attention", id: "att-1", detail: "Please review\nmore" });
    expect(global).toEqual([{ type: "session.attention", sessionId: chat.id, cwd: "/work/a", sessionName: "Durable Chat", kind: "attention", id: "att-1", detail: "Please review" }]);
    expect(hub.currentSeq(chat.id)).toBe(0);
  });

  it("forwards model switching and effect resolution to the host", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => request.method === "models" ? [{ provider: "faux", id: "faux-1", name: "Faux" }, { provider: "anthropic", id: "claude-x", name: "Claude X" }] : status;
    await expect(durable.modelCatalog(ref)).resolves.toEqual([
      { provider: "faux", id: "faux-1", name: "Faux", enabled: true, editable: false, catalogIndex: 0 },
      { provider: "anthropic", id: "claude-x", name: "Claude X", enabled: true, editable: false, catalogIndex: 1 },
    ]);
    await durable.setModel(ref, "anthropic", "claude-x");
    await durable.resolveEffect(ref, "13", "retry");
    const calls = only(launched).requests.filter((request) => request.method === "setModel" || request.method === "resolveEffect").map((request) => [request.method, request.params]);
    expect(calls).toEqual([["setModel", { provider: "anthropic", modelId: "claude-x" }], ["resolveEffect", { taskId: "13", resolution: "retry" }]]);
  });

  it("stops a Chat's host only once its process has exited, so the next host can take the store", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).exitDelayMs = 50;
    let exited = false;
    only(launched).on("exit", () => { exited = true; });
    await durable.stop(ref);
    expect(exited).toBe(true);
    await durable.status(ref);
    expect(launched).toHaveLength(2);
  });

  // P086 /quota-check: host-listed commands, run in the host under a fresh operation id.
  it("lists the host's Workbench commands and runs them in the host; /mode and unknown commands keep their paths", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => request.method === "commands"
      ? [{ name: "quota-check", description: "Check Claude quota" }]
      : request.method === "command" ? (request.params?.["name"] === "quota-check" ? { type: "done", message: "Claude quota telemetry is fresh." } : { type: "unsupported", message: `/${String(request.params?.["name"])} is not available in Durable Chats yet` })
      : status;
    await expect(durable.commands(ref)).resolves.toEqual([
      expect.objectContaining({ name: "mode" }),
      expect.objectContaining({ name: "name" }),
      { name: "quota-check", description: "Check Claude quota", source: "extension" },
      expect.objectContaining({ name: "session" }),
    ]);
    await expect(durable.runCommand(ref, "/quota-check  repair ")).resolves.toEqual({ type: "done", message: "Claude quota telemetry is fresh." });
    const command = only(launched).requests.find((request) => request.method === "command");
    expect(command?.params).toMatchObject({ name: "quota-check", args: "repair" });
    expect(String(command?.params?.["operationId"])).toMatch(/^[0-9a-f-]{36}$/);
    await expect(durable.runCommand(ref, "/tree")).resolves.toEqual({ type: "unsupported", message: "/tree is not available in Durable Chats yet" });
  });

  it("keeps working with a host that lists no commands", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => { if (request.method === "commands" || request.method === "command") throw new Error(`Unknown method ${request.method}`); return status; };
    expect((await durable.commands(ref)).map((command) => command.name)).toEqual(["mode", "name", "session"]);
    await expect(durable.runCommand(ref, "/quota-check")).resolves.toEqual({ type: "unsupported", message: "/quota-check is not available in Durable Chats yet" });
  });

  // P073: the host's shell activity reaches the browser's status unchanged.
  it("passes the host's running shell calls through to status", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const shell = { id: "tool:call-1", kind: "shell", toolName: "bash", label: "Shell command", startedAt: "2026-10-22T10:00:00.000Z" };
    only(launched).answer = () => ({ ...status, activeToolExecutions: [shell] });
    await expect(durable.status(ref)).resolves.toMatchObject({ activeToolExecutions: [shell] });
  });

  it("feeds committed turn starts and ends into the shared unread catalog; a host exit only forgets the running latch", async () => {
    const { durable, launched, unread } = await service();
    const chat = await durable.start("/work/a");
    only(launched).push({ type: "agent.start" });
    only(launched).push({ type: "agent.end" });
    only(launched).push({ type: "agent.start" });
    only(launched).kill();
    await Promise.resolve();
    expect(unread).toEqual([[chat.id, "/work/a", "active"], [chat.id, "/work/a", "idle"], [chat.id, "/work/a", "active"], [chat.id, "/work/a", "closed"]]);
  });

  it("names the Chat with /name in the catalog and tells every browser, reports /session stats, and lists both commands", async () => {
    const { durable, hub, launched, locator } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const global: unknown[] = [];
    hub.addGlobal({ OPEN: 1, readyState: 1, send: (payload) => { global.push(JSON.parse(payload)); }, terminate: () => undefined, on: () => undefined });
    only(launched).answer = (request) => request.method === "transcript"
      ? { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }, { role: "toolResult", content: [] }, { role: "assistant", content: [{ type: "text", text: "done" }] }], partial: null, status: { ...status, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.25 } }
      : request.method === "command" ? { type: "unsupported", message: `/${String(request.params?.["name"])} is not available in Durable Chats yet` }
      : status;
    await expect(durable.runCommand(ref, "/name")).resolves.toEqual({ type: "unsupported", message: "Usage: /name <session name>" });
    const named = await durable.runCommand(ref, "/name Release prep");
    expect(named).toMatchObject({ type: "done", message: "Session named: Release prep", session: { id: chat.id, name: "Durable · Release prep" } });
    expect(locator.durable(chat.id)?.name).toBe("Release prep");
    expect(global).toContainEqual({ type: "session.name", sessionId: chat.id, name: "Durable · Release prep" });
    only(launched).push({ type: "message.end", message: { role: "user", content: "first words", entryId: "1" } });
    expect(durable.list("/work/a")[0]?.name).toBe("Durable · Release prep");
    await expect(durable.runCommand(ref, "/session")).resolves.toEqual({ type: "done", message: [
      `Session: ${chat.id}`, "Messages: 4 (1 user, 2 assistant)", "Tool calls: 1", "Tokens: ↑10 ↓5 total 15", "Cost: $0.2500",
    ].join("\n") });
    const names = (await durable.commands(ref)).map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["mode", "name", "session"]));
    await expect(durable.runCommand(ref, "/export")).resolves.toEqual({ type: "unsupported", message: "/export is not available in Durable Chats yet" });
  });

  it("reports the gated operations the host supports on status, transcript and listing; a host without a list supports none", async () => {
    const { durable, hub, launched } = await service((launch) => new FakeHost(DURABLE_HOST_PROTOCOL, launch === 0 ? ["attachments", "teleport"] : undefined));
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => request.method === "transcript" ? { messages: [], partial: null, status } : status;
    expect((await durable.status(ref)).capabilities).toEqual(["attachments"]);
    expect((await durable.transcriptSnapshot(ref)).status.capabilities).toEqual(["attachments"]);
    expect(durable.list("/work/a")[0]?.capabilities).toEqual(["attachments"]);
    const global: unknown[] = [];
    hub.addGlobal({ OPEN: 1, readyState: 1, send: (payload) => { global.push(JSON.parse(payload)); }, terminate: () => undefined, on: () => undefined });
    only(launched).push({ type: "status.update", status });
    expect(global).toMatchObject([{ type: "status.update", status: { ...status, sessionId: chat.id, capabilities: ["attachments"] } }]);
    await durable.stop(ref);
    expect((await durable.status(ref)).capabilities).toEqual([]);
  });
});
