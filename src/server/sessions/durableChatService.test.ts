import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { chatKey, DURABLE_HOST_PROTOCOL, DurableChatService, IDLE_HOST_CLOSE_MS, durableHostArgs, durableHostLaunchArgs, type DurableHostProcess, forkDurableHost } from "./durableChatService.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";
import { WorkstreamLaunchStore } from "./workstreamLaunchStore.js";
import { SESSION_TITLE_SYSTEM_PROMPT } from "./sessionNameGenerator.js";
import type { DurableChatResourceSet, DurableContributedResources } from "./durableChatResources.js";
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

/** An `answer` that never replies: the daemon dies while it waits. */
const NO_REPLY = Symbol("no reply");

/** A host process double: answers requests through `answer`, pushes events, and exits on demand. */
class FakeHost extends EventEmitter implements DurableHostProcess {
  readonly requests: Request[] = [];
  answer: (request: Request) => unknown = (request) => (request.method === "status" ? status : null);

  constructor(protocol = DURABLE_HOST_PROTOCOL, capabilities?: unknown, ready: object = {}) {
    super();
    queueMicrotask(() => { this.emit("message", { ready: { protocol, ...(capabilities === undefined ? {} : { capabilities }), ...ready } }); });
  }

  send(message: unknown): boolean {
    if (!isRequest(message)) throw new Error("not a host request");
    const request = message;
    this.requests.push(request);
    queueMicrotask(() => {
      try {
        const result = this.answer(request);
        if (result === NO_REPLY) return;
        this.emit("message", { id: request.id, result });
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

async function service(make: (launch: number) => FakeHost = () => new FakeHost(), resources?: DurableChatResourceSet | ((cwd: string, contributed?: DurableContributedResources) => Promise<DurableChatResourceSet>), extra: Partial<ConstructorParameters<typeof DurableChatService>[0]> = {}): Promise<{ durable: DurableChatService; hub: SessionEventHub; locator: SessionRuntimeLocator; launched: FakeHost[]; root: string; unread: UnreadCall[] }> {
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
    ...(resources === undefined ? {} : { resources: typeof resources === "function" ? resources : () => Promise.resolve(resources) }),
    unread: (sessionId, cwd, change) => { unread.push([sessionId, cwd, change]); return Promise.resolve(); },
    ...extra,
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

  it("reads a Chat with no host through a one-off reader, never a started host; a failed reader starts the host as before", async () => {
    const launches: { readTranscript: boolean }[] = [];
    let readerCode = 0;
    const hosts: FakeHost[] = [];
    const launch = (_record: unknown, _storeDir: string, options?: { readTranscript?: boolean }) => {
      launches.push({ readTranscript: options?.readTranscript === true });
      if (options?.readTranscript !== true) {
        const host = new FakeHost();
        host.answer = (request) => (request.method === "transcript" ? { messages: [{ role: "user", content: "live", entryId: "2" }], partial: null, status } : status);
        hosts.push(host);
        return host;
      }
      const reader = Object.assign(new EventEmitter(), { send: () => false, kill: () => false });
      queueMicrotask(() => {
        if (readerCode === 0) reader.emit("message", { transcript: { messages: [{ role: "user", content: "stored", entryId: "1" }] } });
        reader.emit("exit", readerCode, null);
      });
      return reader;
    };
    const { durable } = await service(undefined, undefined, { launch });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    // A running host answers itself.
    expect((await durable.messages(ref)).messages).toEqual([{ role: "user", content: "live", entryId: "2" }]);
    only(hosts).kill();
    launches.length = 0;

    expect((await durable.messages(ref)).messages).toEqual([{ role: "user", content: "stored", entryId: "1" }]);
    expect(launches).toEqual([{ readTranscript: true }]);

    // Host code without the reader (an older pin) exits nonzero: the read starts the host, as before.
    readerCode = 1;
    launches.length = 0;
    expect((await durable.messages(ref)).messages).toEqual([{ role: "user", content: "live", entryId: "2" }]);
    expect(hosts).toHaveLength(2);
    expect(launches).toEqual([{ readTranscript: true }, { readTranscript: false }]);
  });

  it("recovers from a reader that cannot start: a launcher refusal or a spawn error fails that read only, and the next read runs", async () => {
    let mode: "throw" | "error" | "ok" = "throw";
    const hosts: FakeHost[] = [];
    const launch = (_record: unknown, _storeDir: string, options?: { readTranscript?: boolean }) => {
      if (options?.readTranscript !== true) {
        const host = new FakeHost();
        host.answer = (request) => (request.method === "transcript" ? { messages: [{ role: "user", content: "live" }], partial: null, status } : status);
        hosts.push(host);
        return host;
      }
      if (mode === "throw") throw new Error("pinned host code is gone");
      const reader = Object.assign(new EventEmitter(), { send: () => false, kill: () => false });
      // A spawn failure: "error" and no "exit".
      if (mode === "error") queueMicrotask(() => reader.emit("error", new Error("spawn ENOENT")));
      else queueMicrotask(() => { reader.emit("message", { transcript: { messages: [{ role: "user", content: "stored" }] } }); reader.emit("exit", 0, null); });
      return reader;
    };
    const { durable } = await service(undefined, undefined, { launch });
    const [a, b, c] = [await durable.start("/work/a"), await durable.start("/work/b"), await durable.start("/work/c")];
    for (const host of hosts.splice(0)) host.kill();

    expect((await durable.messages({ id: a.id, cwd: a.cwd })).messages).toEqual([{ role: "user", content: "live" }]);
    mode = "error";
    expect((await durable.messages({ id: b.id, cwd: b.cwd })).messages).toEqual([{ role: "user", content: "live" }]);
    mode = "ok";
    expect((await durable.messages({ id: c.id, cwd: c.cwd })).messages).toEqual([{ role: "user", content: "stored" }]);
    expect(hosts).toHaveLength(2);
  });

  it("fails a request sent while a killed host's IPC channel is closing, without an unhandled error, and reopens", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const first = only(launched);
    // Node's ChildProcess.send on a closed channel: the error goes to the callback, else to an "error" event a tick later.
    let unhandled: unknown;
    first.send = (_message: unknown, callback?: (error: Error | null) => void): boolean => {
      const error = Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
      process.nextTick(() => {
        if (callback !== undefined) callback(error);
        else try { first.emit("error", error); } catch (thrown) { unhandled = thrown; }
      });
      return false;
    };
    await expect(durable.status(ref)).rejects.toThrow(/Channel closed/);
    expect(unhandled).toBeUndefined();
    // A ChildProcess error from elsewhere (a failed kill) is contained too.
    expect(() => first.emit("error", new Error("kill EPERM"))).not.toThrow();
    first.kill();
    await expect(durable.status(ref)).resolves.toMatchObject({ sessionId: chat.id });
    expect(launched).toHaveLength(2);
  });

  it("shows Pi's cache-miss notice on a paid Durable turn, live and re-derived from history, only when enabled (P023)", async () => {
    const turn = (entryId: string, timestamp: number, usage: { input: number; cacheRead: number }) => ({
      role: "assistant", provider: "openai-codex", model: "gpt", content: [{ type: "text", text: "answer" }], stopReason: "stop", timestamp, entryId,
      usage: { ...usage, cacheWrite: 0, output: 10, totalTokens: usage.input + usage.cacheRead + 10, cost: { input: usage.input * 3e-6, output: 0, cacheRead: usage.cacheRead * 0.3e-6, cacheWrite: 0, total: 0 } },
    });
    const warm = turn("a1", 0, { input: 100, cacheRead: 50_000 });
    const missed = turn("a2", 60_000, { input: 50_100, cacheRead: 0 });
    const notice = "Cache miss: 50k tokens re-billed (~$0.15)";
    let enabled = true;
    const { durable, hub, launched } = await service(undefined, undefined, { cacheMissNotices: { enabled: () => enabled, models: { getModel: () => undefined } } });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const host = only(launched);
    const published: unknown[] = [];
    hub.add(chat.id, { OPEN: 1, readyState: 1, send: (payload) => { published.push(JSON.parse(payload)); }, terminate: () => undefined, on: () => undefined });
    let history: unknown[] = [{ role: "user", content: "hi", entryId: "u1" }, warm];
    host.answer = (request) => (request.method === "transcript" ? { messages: history, partial: null, status } : request.method === "status" ? status : null);
    await durable.transcriptSnapshot(ref);
    host.push({ type: "message.end", message: missed });
    expect(published.at(-1)).toMatchObject({ type: "message.end", message: { entryId: "a2", cacheMissNotice: notice } });
    history = [...history, missed];
    const notices = async () => (await durable.messages(ref)).messages.map((message) => (typeof message === "object" && message !== null && "cacheMissNotice" in message ? message.cacheMissNotice : undefined));
    expect(await notices()).toEqual([undefined, undefined, notice]);
    expect((await durable.transcriptSnapshot(ref)).page.messages.at(-1)).toMatchObject({ entryId: "a2", cacheMissNotice: notice });
    // A context reset, or the setting off, shows none.
    history = [{ role: "user", content: "hi", entryId: "u1" }, warm, { role: "system", source: "compaction", content: "Compacted", entryId: "c1" }, missed];
    expect(await notices()).toEqual([undefined, undefined, undefined, undefined]);
    enabled = false;
    history = [warm, missed];
    expect(await notices()).toEqual([undefined, undefined]);
    host.push({ type: "message.end", message: { ...missed, entryId: "a3" } });
    expect(published.at(-1)).not.toHaveProperty("message.cacheMissNotice");
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
      expect.objectContaining({ name: "pair", source: "extension" }),
      expect.objectContaining({ name: "session", source: "builtin" }),
      { name: "skill:tidy", description: "Tidy up", source: "skill" },
      expect.objectContaining({ name: "tabname", source: "builtin" }),
    ]);
    await durable.prompt(ref, "/skill:tidy src only", undefined, undefined, { operationId: "op-7" });
    const prompt = only(launched).requests.find((request) => request.method === "prompt");
    expect(prompt?.params).toEqual({ operationId: "op-7", text: `<skill name="tidy" location="${filePath}">\nReferences are relative to ${skillDir}.\n\nTidy every file.\n</skill>\n\nsrc only` });
  });

  it("loads the resources the host's packages contributed in its ready message (P110); a malformed list is ignored", async () => {
    const loads: (DurableContributedResources | undefined)[] = [];
    const set: DurableChatResourceSet = { resources: { sources: [] }, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, skillList: [] };
    const contributed = { skillPaths: [{ path: "/pkg/skills", extensionPath: "/pkg/probe.ts" }], promptPaths: [], themePaths: [] };
    const readies = [{ resources: contributed }, { resources: { skillPaths: [{ path: 7 }] } }, {}];
    const { durable } = await service((launch) => new FakeHost(DURABLE_HOST_PROTOCOL, undefined, readies[launch]), (_cwd, given) => { loads.push(given); return Promise.resolve(set); });
    await durable.start("/work/a");
    await durable.start("/work/a");
    await durable.start("/work/a");
    expect(loads).toEqual([{ skillPaths: contributed.skillPaths, promptPaths: [] }, { skillPaths: [], promptPaths: [] }, { skillPaths: [], promptPaths: [] }]);
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

  it("opens /tree and navigates in the host when it reports tree navigation, projecting its entries as legacy Chats do (P044, P046)", async () => {
    const { durable, launched } = await service(() => new FakeHost(DURABLE_HOST_PROTOCOL, ["tree"]));
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const at = "2026-10-22T10:00:00.000Z";
    const nodes = [
      { id: "8", parentId: null, timestamp: at, type: "message", message: { role: "user", content: "first" } },
      { id: "12", parentId: "8", timestamp: at, type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok: first" }] } },
      { id: "13", parentId: "12", timestamp: at, type: "message", message: { role: "user", content: "second" } },
      { id: "24", parentId: "12", timestamp: at, type: "message", message: { role: "user", content: "second v2" } },
    ];
    only(launched).answer = (request) => request.method === "tree" ? { type: "tree", nodes, activeLeafId: "24" }
      : request.method === "navigate" ? { editorText: "second\n\nImage blocks immediately following this text map in order as follows:\n1. [PIC_1]" } : status;
    expect((await durable.commands(ref)).map((command) => command.name)).toContain("tree");
    await expect(durable.runCommand(ref, "/tree")).resolves.toEqual({
      type: "tree",
      tree: {
        nodes: [
          { id: "8", parentId: null, kind: "user", summary: "first", timestamp: at },
          { id: "12", parentId: "8", kind: "assistant", summary: "ok: first", timestamp: at },
          { id: "13", parentId: "12", kind: "user", summary: "second", timestamp: at },
          { id: "24", parentId: "12", kind: "user", summary: "second v2", timestamp: at },
        ],
        activeLeafId: "24",
        activePathIds: ["8", "12", "24"],
      },
    });
    await expect(durable.navigateTree(ref, { targetId: "13", expectedLeafId: "24", summary: { mode: "none" }, retainCheckpoint: true }))
      .resolves.toEqual({ cancelled: false, editorText: "second" });
    expect(only(launched).requests.find((request) => request.method === "navigate")?.params).toEqual({ targetId: "13", expectedLeafId: "24", retainCheckpoint: true });
    // Branch summaries are not offered (unused): refused visibly, never sent to the host.
    await expect(durable.navigateTree(ref, { targetId: "8", expectedLeafId: "24", summary: { mode: "default" } })).rejects.toThrow("Branch summaries is not available in Durable Chats yet");
    expect(only(launched).requests.filter((request) => request.method === "navigate")).toHaveLength(1);
    // The host's refusal while busy reaches the user as a command result.
    only(launched).answer = (request) => request.method === "tree" ? { type: "unsupported", message: "Cannot open the session tree while the session is active. Stop current activity and try /tree again." } : status;
    await expect(durable.runCommand(ref, "/tree")).resolves.toEqual({ type: "unsupported", message: "Cannot open the session tree while the session is active. Stop current activity and try /tree again." });
  });

  it("refuses tree navigation visibly when the host does not report it", async () => {
    const { durable } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    expect((await durable.commands(ref)).map((command) => command.name)).not.toContain("tree");
    await expect(durable.navigateTree(ref, { targetId: "1", expectedLeafId: null, summary: { mode: "none" } })).rejects.toThrow("Tree navigation is not available in Durable Chats yet");
  });

  it("offers and runs /compact only when the host reports the compact capability", async () => {
    const { durable, launched } = await service((launch) => new FakeHost(DURABLE_HOST_PROTOCOL, launch === 0 ? ["compact", "tool-groups"] : []));
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => request.method === "compact" ? { type: "done" } : status;
    expect((await durable.status(ref)).capabilities).toEqual(["compact", "tool-groups"]);
    expect((await durable.commands(ref)).map((command) => command.name)).toEqual(["compact", "mode", "name", "pair", "session", "tabname"]);
    await expect(durable.runCommand(ref, "/compact Keep the test names")).resolves.toEqual({ type: "done" });
    await expect(durable.runCommand(ref, "/compact")).resolves.toEqual({ type: "done" });
    expect(only(launched).requests.filter((request) => request.method === "compact").map((request) => request.params)).toEqual([{ instructions: "Keep the test names" }, {}]);

    // An older host without the capability: no /compact command, and running it is refused visibly.
    await durable.stop(ref);
    expect((await durable.commands(ref)).map((command) => command.name)).toEqual(["mode", "name", "pair", "session", "tabname"]);
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
    expect(commands.map((command) => command.name)).toEqual(["mode", "monitors", "name", "pair", "ping", "session", "tabname"]);
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

  it("resizes answer images and sends them with closeAsk, named in the answers text; a host without ask-images refuses them", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const { durable, launched } = await service((launch) => new FakeHost(DURABLE_HOST_PROTOCOL, launch === 0 ? ["ask-images"] : []));
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, questions: [{ id: "why", question: "Why?", kind: "text", options: [] }] };
    only(launched).answer = (request) => (request.method === "closeAsk" ? { result: "closed", outcome: request.params?.["outcome"] } : { ...status, pendingAsks: [ask] });
    const closed = await durable.submitAsk(ref, "ask-1", { answers: [{ id: "why", values: [], value: "Look" }], revision: "r1", images: [{ target: { kind: "question", id: "why" }, mimeType: "image/png", data: png, name: "shot.png" }] }, "op-i");
    expect(closed.outcome?.images).toEqual([{ target: { kind: "question", id: "why" }, reference: "[PIC_1]", mimeType: "image/png", name: "shot.png" }]);
    const params = only(only(launched).requests.filter((r) => r.method === "closeAsk")).params ?? {};
    expect(params["images"]).toMatchObject([{ type: "image", mimeType: "image/png" }]);
    expect(JSON.stringify(params["images"])).toMatch(/"data":"[A-Za-z0-9+/]+=*"/u);
    expect(String(params["content"])).toContain("  Images: [PIC_1]");
    expect(String(params["content"])).toMatch(/Image blocks immediately following this text map in order as follows:\n1\. \[PIC_1\]$/u);
  });

  it("refuses answer images when the Chat's host does not report ask-images", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, questions: [{ id: "why", question: "Why?", kind: "text", options: [] }] };
    only(launched).answer = (request) => (request.method === "closeAsk" ? { result: "closed", outcome: request.params?.["outcome"] } : { ...status, pendingAsks: [ask] });
    await expect(durable.submitAsk(ref, "ask-1", { answers: [{ id: "why", values: [], value: "Look" }], revision: "r1", images: [{ target: { kind: "question", id: "why" }, mimeType: "image/png", data: "iVBORw0KGgo=" }] })).rejects.toThrow(/Images in answers/u);
    expect(only(launched).requests.filter((r) => r.method === "closeAsk")).toEqual([]);
  });

  it("a partial submit sends one answer and tells the model the rest of the set stays open; the host keeps it open at the new revision", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, context: "Pick", questions: [
      { id: "db", question: "Which database?", detail: "Storage.", options: [{ value: "pg", label: "Postgres" }] },
      { id: "cache", question: "Which cache?", detail: "Caching.", options: [{ value: "redis", label: "Redis" }] },
    ] };
    only(launched).answer = (request) => (request.method === "closeAsk" ? { result: "closed", outcome: request.params?.["outcome"] } : { ...status, pendingAsks: [ask] });
    const sent = await durable.submitAsk(ref, "ask-1", { answers: [{ id: "db", values: ["pg"] }], revision: "r1", partial: true }, "op-p");
    expect(sent).toMatchObject({ result: "closed", outcome: { askId: "ask-1", partial: true, answeredCount: 1 } });
    const request = only(only(launched).requests.filter((r) => r.method === "closeAsk"));
    // Only the answered question, and the new revision the set continues under at the host.
    expect(request.params).toMatchObject({ askId: "ask-1", operationId: "op-p", revision: "r1", outcome: { partial: true, questions: [{ question: { id: "db" } }] } });
    expect(request.params?.["outcome"]).toHaveProperty("revision");
    expect(request.params?.["outcome"]).not.toHaveProperty("revision", "r1");
    const content = String(request.params?.["content"]);
    expect(content).toContain("The user answered one question of question set ask-1; its other questions stay open.");
    // As a legacy Chat: the reminder that follows names the set still open, with only its unanswered question.
    expect(content).toMatch(/Question sets still open for the user[^\n]*\n- ask-1 \(ask\.cache; [^)]*\): Which cache\?/);
  });

  it("returns the whole set's record on its last send, from the earlier partial sends the host recorded", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const db = { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] };
    const cache = { id: "cache", question: "Which cache?", options: [{ value: "redis", label: "Redis" }] };
    // Only cache is left: db went with a partial send, e.g. from another device.
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r2", turnsSinceUpdate: 0, context: "Pick", questions: [cache] };
    const earlier = { askId: "ask-1", reason: "submitted", askedAt: ask.askedAt, closedAt: ask.askedAt, context: "Pick", questions: [{ question: db, answered: true, values: ["pg"] }], answeredCount: 1, unansweredIds: [], summary: "Answered 1; still open: ask.cache", partial: true, revision: "r2" };
    only(launched).answer = (request) => (request.method === "closeAsk" ? { result: "closed", outcome: request.params?.["outcome"], earlier: [earlier] } : { ...status, pendingAsks: [ask] });
    const closed = await durable.submitAsk(ref, "ask-1", { answers: [{ id: "cache", values: ["redis"] }], revision: "r2" }, "op-f");
    expect(closed.outcome?.questions.map((record) => [record.question.id, record.values])).toEqual([["db", ["pg"]], ["cache", ["redis"]]]);
    expect(closed.outcome).toMatchObject({ answeredCount: 2, summary: "Answered 2 of 2; none left unanswered" });
    // The model hears only this send's answer.
    expect(String(only(only(launched).requests.filter((r) => r.method === "closeAsk")).params?.["content"])).not.toContain("selected pg");
  });

  it("numbers the whole set's record in the set's question order the host returns, not in send order", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const db = { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] };
    const cache = { id: "cache", question: "Which cache?", options: [{ value: "redis", label: "Redis" }] };
    // The second question, cache, went first with a partial send; db is left.
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r2", turnsSinceUpdate: 0, context: "Pick", questions: [db] };
    const earlier = { askId: "ask-1", reason: "submitted", askedAt: ask.askedAt, closedAt: ask.askedAt, context: "Pick", questions: [{ question: cache, answered: true, values: ["redis"] }], answeredCount: 1, unansweredIds: [], summary: "Answered 1; still open: ask.db", partial: true, revision: "r2" };
    only(launched).answer = (request) => (request.method === "closeAsk" ? { result: "closed", outcome: request.params?.["outcome"], earlier: [earlier], order: ["db", "cache"] } : { ...status, pendingAsks: [ask] });
    const closed = await durable.submitAsk(ref, "ask-1", { answers: [{ id: "db", values: ["pg"] }], revision: "r2" }, "op-o");
    expect(closed.outcome?.questions.map((record) => record.question.id)).toEqual(["db", "cache"]);
  });

  it("reads open asks and attention only from a running host: a cold Chat answers undefined and starts no host", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, context: "Pick", questions: [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }] };
    only(launched).answer = (request) => (request.method === "status" ? { ...status, pendingAsks: [ask], attentionRequest: { id: "att-1", reason: "Look" } } : null);
    await expect(durable.openAsks(ref)).resolves.toEqual([ask]);
    await expect(durable.attentionRequest(ref)).resolves.toEqual({ id: "att-1", reason: "Look" });
    only(launched).kill();
    await expect(durable.openAsks(ref)).resolves.toBeUndefined();
    await expect(durable.attentionRequest(ref)).resolves.toBeUndefined();
    expect(launched).toHaveLength(1);
    await expect(durable.openAsks({ id: "missing", cwd: "/work/a" })).rejects.toThrow("Session not found");
  });

  it("labels the whole record's context as the user's edit only while the host's set says the user supplied it", async () => {
    const { durable, launched } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const db = { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] };
    const cache = { id: "cache", question: "Which cache?", options: [{ value: "redis", label: "Redis" }] };
    // db went with the user's edit "Mine"; the context of the rest reads "Mine" either way.
    const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-10-22T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z", revision: "r2", turnsSinceUpdate: 0, context: "Mine", questions: [cache] };
    const earlier = { askId: "ask-1", reason: "submitted", askedAt: ask.askedAt, closedAt: ask.askedAt, context: "Pick", editedContext: "Mine", questions: [{ question: db, answered: true, values: ["pg"] }], answeredCount: 1, unansweredIds: [], summary: "Answered 1; still open: ask.cache", partial: true, revision: "r2" };
    const close = async (open: PendingAskUser, operationId: string) => {
      only(launched).answer = (request) => (request.method === "closeAsk" ? { result: "closed", outcome: request.params?.["outcome"], earlier: [earlier] } : { ...status, pendingAsks: [open] });
      return (await durable.submitAsk(ref, "ask-1", { answers: [{ id: "cache", values: ["redis"] }], revision: "r2" }, operationId)).outcome;
    };
    expect(await close({ ...ask, contextEdited: true }, "op-u")).toMatchObject({ editedContext: "Mine" });
    // The agent revised the context back to the same text: its revision, not the user's edit.
    expect(await close(ask, "op-a")).not.toHaveProperty("editedContext");
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

  it("scopes the models to the settings' enabledModels, as a legacy Chat does", async () => {
    const { durable, launched } = await service(undefined, undefined, { enabledModels: () => ["anthropic/claude-x", "faux-*", "openai/gone"] });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    only(launched).answer = (request) => request.method === "models" ? [{ provider: "openai", id: "gpt", name: "GPT" }, { provider: "faux", id: "faux-1", name: "Faux" }, { provider: "anthropic", id: "claude-x", name: "Claude X" }] : status;
    // The switch list holds only the enabled models, in enabledModels order.
    expect((await durable.availableModels(ref)).map((model) => `${model.provider ?? ""}/${model.id ?? ""}`)).toEqual(["anthropic/claude-x", "faux/faux-1"]);
    // The catalog lists every model, enabled first, with each model's catalog position.
    await expect(durable.modelCatalog(ref)).resolves.toEqual([
      { provider: "anthropic", id: "claude-x", name: "Claude X", enabled: true, editable: false, catalogIndex: 2 },
      { provider: "faux", id: "faux-1", name: "Faux", enabled: true, editable: false, catalogIndex: 1 },
      { provider: "openai", id: "gpt", name: "GPT", enabled: false, editable: false, catalogIndex: 0 },
    ]);
  });

  it("sends the workspace's default model to a new Chat's host", () => {
    const args = durableHostLaunchArgs({ entry: "host.js", agentDir: "/agent", model: (cwd) => cwd === "/work/a" ? "anthropic/claude-opus-5-5" : "x/y", thinkingLevel: () => "high" }, { id: "c1", cwd: "/work/a" }, "/stores/c1");
    expect(args).toEqual(expect.arrayContaining(["--model", "anthropic/claude-opus-5-5", "--thinking", "high"]));
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

  it("kills a host whose close and SIGTERM both hang, so stop settles, the owner exits and the next host can take the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-durable-stuck-"));
    roots.push(root);
    // A real host process whose close joins work that ignores cancellation: it never answers close and ignores SIGTERM.
    // It owns the store exclusively, as the Durable store lock does: a second owner refuses while the first is alive.
    const entry = join(root, "stuck-host.mjs");
    await writeFile(entry, `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const store = process.argv[process.argv.indexOf("--store") + 1];
      const owner = join(store, "owner");
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      if (existsSync(owner) && alive(Number(readFileSync(owner, "utf8")))) process.exit(3);
      writeFileSync(owner, String(process.pid));
      process.on("SIGTERM", () => {});
      process.on("message", (message) => { if (message.method !== "close") process.send({ id: message.id, result: message.method === "status" ? ${JSON.stringify(status)} : null }); });
      setInterval(() => {}, 1000);
      process.send({ ready: { protocol: ${String(DURABLE_HOST_PROTOCOL)} } });
    `);
    const locator = new SessionRuntimeLocator(root);
    const launch = forkDurableHost({ entry, model: "faux", agentDir: root, thinkingLevel: () => "medium" });
    const exits: (NodeJS.Signals | null)[] = [];
    const durable = new DurableChatService({
      locator,
      events: new SessionEventHub(),
      launch: (record, storeDir) => {
        const host = launch(record, storeDir);
        host.on("exit", (_code, signal) => { exits.push(signal); });
        return host;
      },
      storesDir: join(root, "durable"),
      closeGraceMs: 100,
    });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };

    const started = Date.now();
    await durable.stop(ref);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(exits).toEqual(["SIGKILL"]);
    await durable.status(ref);
    await durable.dispose();
    expect(exits).toEqual(["SIGKILL", "SIGKILL"]);
  }, 15_000);

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
      expect.objectContaining({ name: "pair" }),
      { name: "quota-check", description: "Check Claude quota", source: "extension" },
      expect.objectContaining({ name: "session" }),
      expect.objectContaining({ name: "tabname" }),
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
    expect((await durable.commands(ref)).map((command) => command.name)).toEqual(["mode", "name", "pair", "session", "tabname"]);
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

  it("closing a tab ends the Chat only once no browser watches it and, when work runs, once confirmed", async () => {
    let watching = true;
    const events = Object.assign(new SessionEventHub(), { hasSessionSubscribers: () => watching });
    const { durable, launched } = await service(undefined, undefined, { events, watchGraceMs: 0 });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await durable.status(ref);
    const host = only(launched);
    const busy = { ...status, extensionStatuses: {
      "pi-workbench:background-bash": JSON.stringify({ schemaVersion: 1, jobs: [{ id: "job-1" }, { id: "job-2" }] }),
      "pi-workbench:activity": JSON.stringify({ schemaVersion: 1, items: [{ id: "a", kind: "subagent", startedAt: "2026-11-17T08:00:00Z" }, { id: "b", kind: "subagent", endedAt: "2026-11-17T08:01:00Z" }] }),
    } };
    host.answer = (request) => request.method === "status" ? busy : null;
    const closes = () => host.requests.filter((request) => request.method === "close");

    await expect(durable.stopIfUnwatched(ref, true)).resolves.toEqual({ stopped: false, watched: true });
    watching = false;
    await expect(durable.stopIfUnwatched(ref, false)).resolves.toEqual({ stopped: false, busy: "2 background bash jobs and 1 subagent are running; closing ends them." });
    host.answer = (request) => request.method === "status" ? { ...status, isStreaming: true } : null;
    await expect(durable.stopIfUnwatched(ref, false)).resolves.toEqual({ stopped: false, busy: "A turn is running; closing ends it." });
    expect(closes()).toEqual([]);
    // Confirmed, it ends as Stop does: the host cancels the family's background jobs.
    await expect(durable.stopIfUnwatched(ref, true)).resolves.toEqual({ stopped: true });
    expect(closes().map((request) => request.params)).toEqual([{ end: true }]);
  });

  it("closing a quiet tab's Chat waits for its own socket to go, then ends it without asking", async () => {
    let watching = true;
    const events = Object.assign(new SessionEventHub(), { hasSessionSubscribers: () => watching });
    const { durable, launched } = await service(undefined, undefined, { events, watchGraceMs: 1000 });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await durable.status(ref);
    setTimeout(() => { watching = false; }, 100);
    await expect(durable.stopIfUnwatched(ref, false)).resolves.toEqual({ stopped: true });
    expect(only(launched).requests.filter((request) => request.method === "close").map((request) => request.params)).toEqual([{ end: true }]);
  });

  it("tells a viewed-capable host when its first browser opens the Chat and its last one leaves, again after a reconnect", async () => {
    const { durable, hub, launched } = await service((launch) => new FakeHost(DURABLE_HOST_PROTOCOL, launch === 2 ? [] : ["viewed"]));
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await durable.status(ref);
    const socket = () => Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: () => undefined, terminate: () => undefined });
    const viewed = (host: FakeHost) => host.requests.filter((request) => request.method === "setViewed").map((request) => request.params);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    // Ready with no browser: the host hears the current state once.
    expect(viewed(only(launched))).toEqual([{ viewed: false }]);
    const first = socket();
    const second = socket();
    hub.add(chat.id, first);
    hub.add(chat.id, second);
    await settle();
    first.emit("close");
    await settle();
    expect(viewed(only(launched))).toEqual([{ viewed: false }, { viewed: true }]);
    second.emit("close");
    await settle();
    expect(viewed(only(launched))).toEqual([{ viewed: false }, { viewed: true }, { viewed: false }]);

    // A new host for a watched Chat hears it at its ready handshake; a host without the capability hears nothing.
    hub.add(chat.id, socket());
    await durable.stop(ref);
    await durable.status(ref);
    expect(viewed(only(launched.slice(1)))).toEqual([{ viewed: true }]);
    await durable.stop(ref);
    await durable.status(ref);
    expect(viewed(only(launched.slice(2)))).toEqual([]);
  });

  it("retries a failed last-close setViewed(false) on the live connection without another change", async () => {
    let failFalse = false;
    const { durable, hub, launched } = await service((): FakeHost => {
      const host = new FakeHost(DURABLE_HOST_PROTOCOL, ["viewed"]);
      const answer = host.answer;
      host.answer = (request) => {
        if (request.method === "setViewed" && failFalse && request.params?.viewed === false) {
          failFalse = false;
          throw new Error("no");
        }
        return answer(request);
      };
      return host;
    });
    const chat = await durable.start("/work/a");
    await durable.status({ id: chat.id, cwd: chat.cwd });
    const viewed = () => only(launched).requests.filter((request) => request.method === "setViewed").map((request) => request.params);
    const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const browser = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: () => undefined, terminate: () => undefined });
    hub.add(chat.id, browser);
    await settle();
    expect(viewed()).toEqual([{ viewed: false }, { viewed: true }]);

    // The last browser leaves and that send fails; the Chat stays closed, yet the host hears false again by itself.
    failFalse = true;
    browser.emit("close");
    await vi.waitFor(() => { expect(viewed()).toEqual([{ viewed: false }, { viewed: true }, { viewed: false }, { viewed: false }]); }, { timeout: 3000 });
    // Taken: nothing more goes out.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(viewed()).toHaveLength(4);
  });

  it("the idle close ends a host that only serves Atelier Pages", async () => {
    let now = Date.parse("2026-11-17T08:00:00Z");
    const { durable, launched } = await service(undefined, undefined, { now: () => now });
    const chat = await durable.start("/work/a");
    await durable.status({ id: chat.id, cwd: chat.cwd });
    only(launched).answer = (request) => request.method === "status" ? { ...status, extensionStatuses: { "pi-workbench:atelier": JSON.stringify({ schemaVersion: 1, serving: true }) } } : null;
    now += IDLE_HOST_CLOSE_MS;
    await durable.closeIdleHosts();
    expect(only(launched).requests.map((request) => request.method)).toContain("close");
  });
});

/** Global events a browser receives, collected. */
function globalEvents(hub: SessionEventHub): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  hub.addGlobal({ OPEN: 1, readyState: 1, send: (payload) => { const event: unknown = JSON.parse(payload); if (typeof event === "object" && event !== null) events.push({ ...event }); }, terminate: () => undefined, on: () => undefined });
  return events;
}

describe("Durable Chats: composer and attention parity (fleet P028 P030 P031 P032 P033)", () => {
  it("P030 names each tool phase in the Chat's activity, as a legacy Chat does", async () => {
    const { durable, hub, launched } = await service();
    const chat = await durable.start("/work/a");
    const published = vi.spyOn(hub, "publish");
    const host = only(launched);
    host.push({ type: "agent.start" });
    host.push({ type: "tool.start", toolName: "read", toolCallId: "c1", summary: "" });
    host.push({ type: "tool.end", toolName: "read", toolCallId: "c1", text: "ok", isError: false });
    host.push({ type: "tool.start", toolName: "bash", toolCallId: "c2", summary: "" });
    host.push({ type: "tool.end", toolName: "bash", toolCallId: "c2", text: "boom", isError: true });
    host.push({ type: "agent.end" });
    const activity = published.mock.calls.map(([, event]) => event).filter((event) => event.type === "activity.update").map((event) => event.activity);
    expect(activity.map(({ phase, label, sessionId }) => ({ phase, label, sessionId }))).toEqual([
      { phase: "active", label: "agent running", sessionId: chat.id },
      { phase: "active", label: "running tool: read", sessionId: chat.id },
      { phase: "active", label: "tool complete: read", sessionId: chat.id },
      { phase: "active", label: "running tool: bash", sessionId: chat.id },
      { phase: "error", label: "tool failed: bash", sessionId: chat.id },
      { phase: "idle", label: "idle", sessionId: chat.id },
    ]);
  });

  it("P031 titles a Chat from its first substantive prompt through its host's model; later prompts and /name keep their precedence", async () => {
    const { durable, hub, launched, locator } = await service(undefined, undefined, { config: { read: () => ({ effectiveConfig: { sessionNaming: { model: "anthropic/claude-haiku", maxTokens: 30 } } }) } });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const host = only(launched);
    host.answer = (request) => request.method === "complete" ? "Title: Migration review" : request.method === "status" ? status : null;
    const events = globalEvents(hub);
    await durable.prompt(ref, "Please review this substantial migration plan");
    await vi.waitFor(() => { expect(durable.list("/work/a")[0]?.name).toBe("Durable · Migration review"); });
    const complete = host.requests.filter(isTitleRequest);
    expect(complete).toHaveLength(1);
    expect(complete[0]?.params).toMatchObject({
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
      prompt: "Create a 2-6 word title for this request:\n\nPlease review this substantial migration plan",
      maxTokens: 30, reasoning: "minimal", model: { provider: "anthropic", modelId: "claude-haiku" },
    });
    expect(events).toContainEqual({ type: "session.name", sessionId: chat.id, name: "Durable · Migration review" });
    expect(locator.durable(chat.id)).toMatchObject({ name: "Migration review", nameSource: "auto" });
    // The first prompt is recorded; a later one asks for no new title.
    host.push({ type: "message.end", message: { role: "user", content: "Please review this substantial migration plan", entryId: "1" } });
    await durable.prompt(ref, "continue");
    await durable.runCommand(ref, "/name Explicit owner title");
    expect(locator.durable(chat.id)).toMatchObject({ name: "Explicit owner title", nameSource: "manual" });
    expect(host.requests.filter(isTitleRequest)).toHaveLength(1);
  });

  it("names a Chat's tab in one or two words from each new title, never over the owner's /tabname", async () => {
    const { durable, hub, launched, locator } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const host = only(launched);
    let tabName = "Migration review";
    host.answer = (request) => request.method === "complete" ? (String(request.params?.["prompt"]).startsWith("Create a one- or two-word tab label") ? tabName : "Migration plan review") : request.method === "status" ? status : null;
    const events = globalEvents(hub);
    await durable.prompt(ref, "Please review this substantial migration plan");
    await vi.waitFor(() => { expect(locator.durable(chat.id)).toMatchObject({ shortName: "Migration review", shortNameSource: "auto" }); });
    expect(host.requests.find((request) => request.method === "complete" && !isTitleRequest(request))?.params?.["prompt"]).toBe("Create a one- or two-word tab label for this chat title:\n\nMigration plan review");
    expect(events).toContainEqual({ type: "session.name", sessionId: chat.id, name: "Durable · Migration plan review", shortName: "Migration review" });
    expect(durable.list("/work/a")[0]?.shortName).toBe("Migration review");

    // A long answer names no tab, and the old title's generated name goes with it; the owner's name stays through a
    // new title, and an empty /tabname hands it back.
    tabName = "A far too long tab name";
    await durable.runCommand(ref, "/name Database migration");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(locator.durable(chat.id)?.shortName).toBeUndefined();
    expect(await durable.runCommand(ref, "/tabname Way too many words")).toMatchObject({ type: "unsupported" });
    expect(await durable.runCommand(ref, "/tabname Migrations")).toMatchObject({ type: "done", session: { shortName: "Migrations" } });
    tabName = "DB migration";
    await durable.runCommand(ref, "/name Database migration rollout");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(locator.durable(chat.id)).toMatchObject({ shortName: "Migrations", shortNameSource: "manual" });
    expect(await durable.runCommand(ref, "/tabname")).toMatchObject({ type: "done" });
    await vi.waitFor(() => { expect(locator.durable(chat.id)).toMatchObject({ shortName: "DB migration", shortNameSource: "auto" }); });
  });

  it("clears an owner's tab name even with no host to name it again, and names an older titled Chat's tab on its next prompt", async () => {
    const { durable, launched, locator } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await durable.runCommand(ref, "/tabname Foo");
    // A Chat titled before tab names existed: a title, no tab name.
    locator.update(chat.id, { name: "Old release checklist", nameSource: "auto", shortName: undefined, shortNameSource: "auto" });
    expect(locator.durable(chat.id)?.shortName).toBeUndefined();
    await durable.runCommand(ref, "/tabname Foo");
    only(launched).answer = () => { throw new Error("host gone"); };
    expect(await durable.runCommand(ref, "/tabname")).toMatchObject({ type: "done" });
    expect(locator.durable(chat.id)).toMatchObject({ shortNameSource: "auto" });
    expect(locator.durable(chat.id)?.shortName).toBeUndefined();

    only(launched).answer = (request) => request.method === "complete" ? "Release list" : request.method === "status" ? status : null;
    await durable.prompt(ref, "continue");
    await vi.waitFor(() => { expect(locator.durable(chat.id)).toMatchObject({ shortName: "Release list", shortNameSource: "auto" }); });
  });

  it("P031 falls back to the prompt's first words when the title request fails, and never overrides an owner's /name", async () => {
    const { durable, launched } = await service();
    const failing = await durable.start("/work/a");
    only(launched).answer = (request) => { if (request.method === "complete") throw new Error("model unavailable"); return request.method === "redact" ? request.params?.["text"] : request.method === "status" ? status : null; };
    await durable.prompt({ id: failing.id, cwd: "/work/a" }, "Fix the flaky login test in CI today please");
    await vi.waitFor(() => { expect(durable.list("/work/a", failing.id)[0]?.name).toBe("Durable · Fix the flaky login test in"); });

    const named = await durable.start("/work/b");
    const host = launched[1];
    if (host === undefined) throw new Error("second host");
    await durable.runCommand({ id: named.id, cwd: "/work/b" }, "/name Mine");
    await durable.prompt({ id: named.id, cwd: "/work/b" }, "Fix the flaky login test");
    expect(host.requests.some(isTitleRequest)).toBe(false);
    expect(durable.list("/work/b")[0]?.name).toBe("Durable · Mine");
  });

  it("N3 builds the fallback title from the prompt as the host's redactor masks it; with no redactor answer the Chat stays untitled", async () => {
    const secret = `ghp_${"F4llb4ckS3cr3t".repeat(3)}`;
    const prompt = `Use ${secret} to deploy the login service today`;
    const { durable, hub, launched, locator } = await service();
    const chat = await durable.start("/work/a");
    const host = only(launched);
    // The host's redactor (Workbench `sealed(redact)`): a whole-text mask before any formatting.
    host.answer = (request) => {
      if (request.method === "complete") throw new Error("model unavailable");
      if (request.method === "redact") return String(request.params?.["text"]).replace(/ghp_[A-Za-z0-9]+/g, "[REDACTED:github-token]");
      return request.method === "status" ? status : null;
    };
    const events = globalEvents(hub);
    await durable.prompt({ id: chat.id, cwd: "/work/a" }, prompt);
    await vi.waitFor(() => { expect(locator.durable(chat.id)?.nameSource).toBe("auto"); });
    expect(host.requests.find((request) => request.method === "redact")?.params).toEqual({ text: prompt });
    expect(locator.durable(chat.id)?.name).toBe("Use REDACTED:github-token to deploy the login");
    const body = secret.slice(4, 16);
    expect(JSON.stringify(locator.durable(chat.id))).not.toContain(body);
    expect(JSON.stringify(events)).not.toContain(body);

    // A host without a redactor (or one that died with the title request): no fallback title at all.
    const second = await durable.start("/work/b");
    const old = launched[1];
    if (old === undefined) throw new Error("second host");
    old.answer = (request) => { if (request.method === "complete" || request.method === "redact") throw new Error("Unknown method"); return request.method === "status" ? status : null; };
    await durable.prompt({ id: second.id, cwd: "/work/b" }, prompt);
    await vi.waitFor(() => { expect(old.requests.some((request) => request.method === "redact")).toBe(true); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(locator.durable(second.id)?.name).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain(body);
  });

  it("P032 applies a Workstream checkpoint title without a turn, unless the owner named the Chat", async () => {
    const { durable, hub, launched, locator } = await service();
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const events = globalEvents(hub);
    await expect(durable.runCommand(ref, "/workstream-checkpoint-title   Checkpoint   fixture ")).resolves.toEqual({ type: "done" });
    expect(locator.durable(chat.id)).toMatchObject({ name: "Checkpoint fixture", nameSource: "checkpoint" });
    expect(events).toContainEqual({ type: "session.name", sessionId: chat.id, name: "Durable · Checkpoint fixture" });
    expect(only(launched).requests.map((request) => request.method)).not.toContain("command");
    expect(only(launched).requests.map((request) => request.method)).not.toContain("prompt");
    await durable.runCommand(ref, "/name Owner title");
    await expect(durable.runCommand(ref, "/workstream-checkpoint-title Later checkpoint")).resolves.toEqual({ type: "done" });
    expect(locator.durable(chat.id)?.name).toBe("Owner title");
  });

  it("P033 binds a Workstream launch token to the Durable Chat it creates; lookups find it only in its workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-launches-"));
    roots.push(root);
    const launches = new WorkstreamLaunchStore(join(root, "launches"));
    const { durable } = await service(undefined, undefined, { launches });
    const chat = await durable.start("/work/a", "pi-web:fleet-1");
    expect(chat.startupToken).toBe("pi-web:fleet-1");
    await expect(durable.lookupWorkstreamLaunch("pi-web:fleet-1", "/work/a")).resolves.toEqual({ status: "found", sessionId: chat.id, cwd: "/work/a" });
    await expect(durable.lookupWorkstreamLaunch("pi-web:fleet-1", "/work/b")).resolves.toBeUndefined();
    await expect(durable.lookupWorkstreamLaunch("pi-web:other", "/work/a")).resolves.toBeUndefined();
    // The token is single-use: a second launch with it is refused instead of creating a duplicate Chat.
    await expect(durable.start("/work/a", "pi-web:fleet-1")).rejects.toThrow(/already reserved/);
    expect(durable.list("/work/a")).toHaveLength(1);
    // A plain startup token is only echoed, as for legacy Chats.
    await expect(durable.start("/work/a", "token-1")).resolves.toMatchObject({ startupToken: "token-1" });
  });

  it("N5 a launch whose confirmation failed stays recoverable: its pending token names the Chat, and a restarted daemon finds and confirms it without a second Chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-launches-"));
    roots.push(root);
    const store = new WorkstreamLaunchStore(join(root, "launches"));
    const failing: Pick<WorkstreamLaunchStore, "reserve" | "confirm" | "lookup"> = {
      reserve: (...args) => store.reserve(...args),
      lookup: (token) => store.lookup(token),
      confirm: () => Promise.reject(new Error("EIO: launch record write failed")),
    };
    const { durable, locator, root: dataDir } = await service(undefined, undefined, { launches: failing });
    await expect(durable.start("/work/a", "pi-web:fleet-2")).rejects.toThrow(/EIO/);
    const orphan = only(locator.all());
    // The reservation already names the Chat it was made for.
    await expect(store.lookup("pi-web:fleet-2")).resolves.toEqual({ token: "pi-web:fleet-2", cwd: "/work/a", status: "pending", sessionId: orphan.id });

    // The daemon restarts: everything is rebuilt from disk.
    const restartedLocator = new SessionRuntimeLocator(dataDir);
    const hosts: FakeHost[] = [];
    const restarted = new DurableChatService({ locator: restartedLocator, events: new SessionEventHub(), launch: () => { const host = new FakeHost(); hosts.push(host); return host; }, storesDir: join(dataDir, "durable"), launches: new WorkstreamLaunchStore(join(root, "launches")) });
    // Reconcile (lookup) finds it without opening its host; a retried launch confirms it and returns the same Chat.
    await expect(restarted.lookupWorkstreamLaunch("pi-web:fleet-2", "/work/a")).resolves.toEqual({ status: "found", sessionId: orphan.id, cwd: "/work/a" });
    await expect(restarted.lookupWorkstreamLaunch("pi-web:fleet-2", "/work/b")).resolves.toBeUndefined();
    expect(hosts).toHaveLength(0);
    await expect(restarted.start("/work/a", "pi-web:fleet-2")).resolves.toMatchObject({ id: orphan.id, startupToken: "pi-web:fleet-2" });
    await expect(store.lookup("pi-web:fleet-2")).resolves.toEqual({ token: "pi-web:fleet-2", cwd: "/work/a", status: "created", sessionId: orphan.id });
    expect(restartedLocator.all().map((record) => record.id)).toEqual([orphan.id]);
    // Once confirmed the token is single-use again, and another workspace cannot claim it.
    await expect(restarted.start("/work/a", "pi-web:fleet-2")).rejects.toThrow(/already reserved/);
    expect(restartedLocator.all()).toHaveLength(1);
  });

  it("N5 a launch whose host never opened keeps its reserved Chat ID: a retry creates that Chat, never a different one", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-launches-"));
    roots.push(root);
    const launches = new WorkstreamLaunchStore(join(root, "launches"));
    const { durable, locator } = await service((launch) => new FakeHost(launch === 0 ? DURABLE_HOST_PROTOCOL + 1 : DURABLE_HOST_PROTOCOL), undefined, { launches });
    await expect(durable.start("/work/a", "pi-web:fleet-3")).rejects.toThrow(/protocol/);
    expect(locator.all()).toEqual([]);
    const pending = await launches.lookup("pi-web:fleet-3");
    expect(pending).toMatchObject({ status: "pending", cwd: "/work/a" });
    await expect(durable.lookupWorkstreamLaunch("pi-web:fleet-3", "/work/a")).resolves.toBeUndefined();
    await expect(durable.start("/work/b", "pi-web:fleet-3")).rejects.toThrow(/already reserved/);
    const chat = await durable.start("/work/a", "pi-web:fleet-3");
    expect(pending?.status === "pending" ? pending.sessionId : undefined).toBe(chat.id);
    expect(locator.all().map((record) => record.id)).toEqual([chat.id]);
    await expect(launches.lookup("pi-web:fleet-3")).resolves.toMatchObject({ status: "created", sessionId: chat.id });
  });

  it("P028 retains a host's package warnings in the Chat's notification inbox; dismissals follow the legacy watermark rules", async () => {
    const notifications = new SessionNotificationStore();
    const { durable, hub, launched } = await service(undefined, undefined, { notifications });
    const chat = await durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const events = globalEvents(hub);
    only(launched).push({ type: "durable.notification", severity: "warning", message: "notice A" });
    only(launched).push({ type: "durable.notification", severity: "error", message: "notice B" });
    const inbox = durable.notificationInbox(ref);
    expect(inbox?.notifications.map(({ message, severity }) => ({ message, severity }))).toEqual([{ message: "notice B", severity: "error" }, { message: "notice A", severity: "warning" }]);
    expect(events.some((event) => event["type"] === "notifications.summary")).toBe(true);
    only(launched).push({ type: "durable.notification", severity: "warning", message: "notice C" });
    if (inbox === undefined) throw new Error("inbox");
    durable.dismissNotification(ref, { daemonInstanceId: inbox.daemonInstanceId, notificationId: inbox.notifications[1]?.id ?? "" });
    const after = durable.dismissAllNotifications(ref, { daemonInstanceId: inbox.daemonInstanceId, throughOrder: inbox.dismissThrough.order, throughOverflowWatermark: inbox.dismissThrough.overflowWatermark });
    expect(after?.notifications.map((notification) => notification.message)).toEqual(["notice C"]);
    expect(notifications.catalogSnapshot().sessions.map((summary) => summary.sessionId)).toEqual([chat.id]);
    // A new host replays its packages' session_start notices: its inbox starts over instead of doubling them.
    only(launched).kill();
    await durable.status(ref);
    expect(durable.notificationInbox(ref)?.notifications).toEqual([]);
    // A Chat whose host has not run in this daemon has no inbox yet.
    const other = { id: "missing", cwd: "/work/a" };
    expect(() => durable.notificationInbox(other)).toThrow("Session not found");
  });
});

describe("Durable Chats: spawn_session (P064)", () => {
  const set: DurableChatResourceSet = { resources: { sources: [] }, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, skillList: [] };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

  it("P064 a host's spawn request starts an independent Durable Chat in an allowed workspace, with the model and thinking level asked for, prompts it once and answers the host", async () => {
    const resolveSpawnTarget = vi.fn((_spawning: string, requested: string | undefined) => Promise.resolve({ allowed: true as const, cwd: requested === "../b" ? "/work/b" : "/work/a" }));
    const { durable, hub, launched, locator } = await service(undefined, set, { spawnTargets: { resolveSpawnTarget } });
    const global = globalEvents(hub);
    const lead = await durable.start("/work/a");
    const host = only(launched);
    expect(host.requests.find((request) => request.method === "configure")?.params).toMatchObject({ spawnSessions: true });
    host.push({ type: "durable.spawn", requestId: "req-1", spawningCwd: "/work/a", prompt: "Fix the build", cwd: "../b", model: "anthropic/claude-x", thinkingLevel: "high" });
    await vi.waitFor(() => { expect(host.requests.some((request) => request.method === "spawned")).toBe(true); });
    expect(resolveSpawnTarget).toHaveBeenCalledWith("/work/a", "../b");
    const child = only(locator.all().filter((record) => record.id !== lead.id));
    expect(child.cwd).toBe("/work/b");
    const spawnedHost = only(launched.slice(1));
    expect(spawnedHost.requests.map((request) => request.method).filter((method) => ["setModel", "setThinkingLevel", "prompt"].includes(method))).toEqual(["setModel", "setThinkingLevel", "prompt"]);
    expect(spawnedHost.requests.find((request) => request.method === "setModel")?.params).toEqual({ provider: "anthropic", modelId: "claude-x" });
    expect(spawnedHost.requests.find((request) => request.method === "prompt")?.params).toMatchObject({ text: "Fix the build" });
    expect(host.requests.find((request) => request.method === "spawned")?.params).toEqual({ requestId: "req-1", result: { sessionId: child.id, cwd: "/work/b", model: "anthropic/claude-x" } });
    expect(global.find((event) => event["type"] === "session.created")).toMatchObject({ session: { id: child.id, cwd: "/work/b" } });
    // The same request again (a retried event) starts nothing new.
    host.push({ type: "durable.spawn", requestId: "req-1", spawningCwd: "/work/a", prompt: "Fix the build", cwd: "../b", model: "anthropic/claude-x", thinkingLevel: "high" });
    await vi.waitFor(() => { expect(host.requests.filter((request) => request.method === "spawned")).toHaveLength(2); });
    expect(locator.all()).toHaveLength(2);
    expect(spawnedHost.requests.filter((request) => request.method === "prompt")).toHaveLength(1);
  });

  it("P064 refuses a workspace outside the project and an unknown model with the host-visible reason, leaving no Chat behind", async () => {
    const resolveSpawnTarget = vi.fn((_spawning: string, requested: string | undefined) => Promise.resolve(requested === "/elsewhere"
      ? { allowed: false as const, reason: "out-of-project" as const, allowedCwds: ["/work/a"] }
      : { allowed: true as const, cwd: "/work/a" }));
    const { durable, launched, locator } = await service((n) => {
      const host = new FakeHost();
      if (n === 1) host.answer = (request) => { if (request.method === "setModel") throw new Error("Unknown model nope/none"); return request.method === "status" ? status : null; };
      return host;
    }, set, { spawnTargets: { resolveSpawnTarget } });
    await durable.start("/work/a");
    const host = only(launched);
    host.push({ type: "durable.spawn", requestId: "r-out", spawningCwd: "/work/a", prompt: "x", cwd: "/elsewhere" });
    await vi.waitFor(() => { expect(host.requests.some((request) => request.method === "spawned")).toBe(true); });
    expect(host.requests.find((request) => request.method === "spawned")?.params).toEqual({ requestId: "r-out", error: "cwd must be a workspace of this project. Allowed: /work/a" });
    host.push({ type: "durable.spawn", requestId: "r-model", spawningCwd: "/work/a", prompt: "x", model: "nope/none" });
    await vi.waitFor(() => { expect(host.requests.filter((request) => request.method === "spawned")).toHaveLength(2); });
    expect(host.requests.filter((request) => request.method === "spawned")[1]?.params).toEqual({ requestId: "r-model", error: "Unknown model nope/none" });
    await flush();
    expect(locator.all()).toHaveLength(1);
  });

  it.each([
    ["the child is prompted but the answer never reaches the lead", "spawned"],
    ["the child is started but its prompt is not yet answered", "prompt"],
  ])("P064 a daemon killed after %s answers the lead's re-sent request after its restart with the same Chat, starting no second one", async (_window, stuck) => {
    const resolveSpawnTarget = () => Promise.resolve({ allowed: true as const, cwd: "/work/b" });
    const launchRoot = await mkdtemp(join(tmpdir(), "pi-web-launches-"));
    roots.push(launchRoot);
    const launches = new WorkstreamLaunchStore(join(launchRoot, "launches"));
    // The lead (first host) or the child (second) stops answering: the daemon dies in that window.
    const { durable, launched, locator, root } = await service((n) => {
      const host = new FakeHost();
      host.answer = (request) => (request.method === stuck && n === (stuck === "spawned" ? 0 : 1) ? NO_REPLY : request.method === "status" ? status : null);
      return host;
    }, set, { spawnTargets: { resolveSpawnTarget }, launches });
    const lead = await durable.start("/work/a");
    const request = { type: "durable.spawn", requestId: "req-1", spawningCwd: "/work/a", prompt: "Fix the build" };
    only(launched).push(request);
    await vi.waitFor(() => { expect(launched[stuck === "spawned" ? 0 : 1]?.requests.some((r) => r.method === stuck)).toBe(true); });
    const child = only(locator.all().filter((record) => record.id !== lead.id));

    // The daemon restarts from disk; the lead's host asks again on the new connection.
    const restartedLocator = new SessionRuntimeLocator(root);
    const restarted = await service(undefined, set, { spawnTargets: { resolveSpawnTarget }, launches, locator: restartedLocator, storesDir: join(root, "durable") });
    await restarted.durable.status({ id: lead.id, cwd: lead.cwd });
    const leadHost = only(restarted.launched);
    leadHost.push(request);
    await vi.waitFor(() => { expect(leadHost.requests.some((r) => r.method === "spawned")).toBe(true); });
    expect(leadHost.requests.find((r) => r.method === "spawned")?.params).toEqual({ requestId: "req-1", result: { sessionId: child.id, cwd: "/work/b" } });
    expect(restartedLocator.all().map((record) => record.id).sort()).toEqual([lead.id, child.id].sort());
    // A child prompt the dead daemon may have sent is the same operation, admitted once by the child's host.
    const childHost = restarted.launched[1];
    for (const prompt of childHost?.requests.filter((r) => r.method === "prompt") ?? []) expect(prompt.params).toMatchObject({ operationId: "spawn-req-1" });
  });

  it("P064 without spawn support the host is told so at configure and a stray request is refused", async () => {
    const { durable, launched } = await service(undefined, set);
    await durable.start("/work/a");
    const host = only(launched);
    expect(host.requests.find((request) => request.method === "configure")?.params).toMatchObject({ spawnSessions: false });
    host.push({ type: "durable.spawn", requestId: "r", spawningCwd: "/work/a", prompt: "x" });
    await vi.waitFor(() => { expect(host.requests.find((request) => request.method === "spawned")?.params).toEqual({ requestId: "r", error: "Spawning sessions is disabled" }); });
  });
});

describe("Durable Chats: send_chat_message", () => {
  const set: DurableChatResourceSet = { resources: { sources: [] }, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, skillList: [] };
  const answered = (host: FakeHost) => host.requests.filter((request) => request.method === "chatMessaged").map((request) => request.params);
  /**
   * The target's host answers `chatMessage` with this delivery, `prompt` with whether its operation was new, and `redact`
   * unchanged (`redacts: false`: a host that cannot redact).
   */
  const target = (delivery = "started", redacts = true) => {
    const host = new FakeHost();
    const ops = new Set<unknown>();
    host.answer = (request) => {
      if (request.method === "chatMessage") return { delivery: request.params?.["wake"] === false ? "noted" : delivery };
      if (request.method === "prompt") { const fresh = !ops.has(request.params?.["operationId"]); ops.add(request.params?.["operationId"]); return { submissionId: ops.size, fresh }; }
      if (request.method === "redact" && redacts) return String(request.params?.["text"]);
      if (request.method === "redact") throw new Error("Unknown method redact");
      return request.method === "status" ? status : null;
    };
    return host;
  };

  async function pair(extra: Partial<ConstructorParameters<typeof DurableChatService>[0]> = {}) {
    const made = await service(() => target(), set, extra);
    const a = await made.durable.start("/work/a");
    made.locator.update(a.id, { name: "Cloud builds for agents" });
    // B exists but its host is not running (closed).
    const b = made.locator.create("/work/b");
    made.locator.update(b.id, { name: "Code only agent" });
    return { ...made, a, b, host: only(made.launched) };
  }

  it("chat keys: first 3 significant words of the title, the first message filling in, a hex fallback and collision suffixes", () => {
    const id = "61f33e34-f3af-493c-a9ba-893a28b45d59";
    expect(chatKey({ id, name: "Cloud builds for the agents", firstMessage: "" }, new Set())).toBe("cloud-builds-agents");
    expect(chatKey({ id, name: "Fix bug", firstMessage: "please rebase the branch" }, new Set())).toBe("fix-bug-please");
    expect(chatKey({ id, name: "Über café", firstMessage: "" }, new Set())).toBe("uber-cafe");
    expect(chatKey({ id, firstMessage: "" }, new Set())).toBe("chat-61f33e34");
    expect(chatKey({ id, name: "Fix bug now", firstMessage: "" }, new Set(["fix-bug-now", "fix-bug-now-2"]))).toBe("fix-bug-now-3");
  });

  it("is enabled at configure; delivers to a closed chat by key, starting its host, with the sender named from the daemon's record", async () => {
    const { host, launched, locator, root, a, b } = await pair();
    expect(host.requests.find((request) => request.method === "configure")?.params).toMatchObject({ chatMessages: true });
    host.push({ type: "durable.chat-list", requestId: "l1" });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(1); });
    expect(answered(host)[0]).toEqual({ requestId: "l1", result: { chats: [{ id: b.id, key: "code-only-agent", title: "Code only agent", cwd: "/work/b", state: "closed" }] } });
    // The host names a different sender: the daemon ignores it.
    host.push({ type: "durable.chat-message", requestId: "m1", chat: "code-only-agent", text: "Rebase on main and rerun the gate.", wake: true, from: { chatId: "owner", name: "The owner" } });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(2); });
    expect(answered(host)[1]).toEqual({ requestId: "m1", result: { chatId: b.id, key: "code-only-agent", name: "Code only agent", delivery: "started", hop: 1 } });
    const delivered = only(launched.slice(1)).requests.find((request) => request.method === "chatMessage")?.params;
    expect(delivered).toEqual({ requestId: "m1", from: { chatId: a.id, key: "cloud-builds-agents", name: "Cloud builds for agents" }, text: "Rebase on main and rerun the gate.", wake: true, urgent: false, hop: 1 });
    // Keys persist and never change after a rename; the UUID works too.
    locator.update(b.id, { name: "Renamed chat" });
    host.push({ type: "durable.chat-message", requestId: "m2", chat: b.id, text: "Second", wake: false });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(3); });
    expect(answered(host)[2]).toMatchObject({ result: { key: "code-only-agent", name: "Renamed chat" } });
    expect(new SessionRuntimeLocator(root).durable(b.id)?.key).toBe("code-only-agent");
  });

  it("refuses self, an unknown chat ID, an unknown key with close matches, and bad text", async () => {
    const { host, a } = await pair();
    host.push({ type: "durable.chat-list", requestId: "l" });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(1); });
    const cases: [object, RegExp][] = [
      [{ chat: a.id, text: "hi" }, /cannot message itself/],
      [{ chat: "00000000-0000-4000-8000-000000000000", text: "hi" }, /No Durable Chat 00000000-0000-4000-8000-000000000000 in this PI WEB/],
      [{ chat: "code-agent", text: "hi" }, /no chat with key code-agent; close matches: code-only-agent/],
      [{ chat: "code-only-agent", text: "" }, /text must be 1 to 8000 characters/],
      [{ chat: "code-only-agent", text: "x".repeat(8001) }, /text must be 1 to 8000 characters/],
    ];
    for (const [index, [event, error]] of cases.entries()) {
      host.push({ type: "durable.chat-message", requestId: `bad-${String(index)}`, wake: true, ...event });
      await vi.waitFor(() => { expect(answered(host)).toHaveLength(index + 2); });
      expect(String(answered(host)[index + 1]?.["error"])).toMatch(error);
    }
  });

  it("allows 2 sends per direction in any 5 minutes; the reply direction counts apart and retries do not count", async () => {
    let now = Date.parse("2026-11-24T10:00:00Z");
    const { host, launched, a, b } = await pair({ now: () => now });
    const send = async (from: FakeHost, requestId: string, chat: string, count: number) => {
      from.push({ type: "durable.chat-message", requestId, chat, text: `msg ${requestId}`, wake: true });
      await vi.waitFor(() => { expect(answered(from)).toHaveLength(count); });
      return answered(from)[count - 1]?.["error"];
    };
    expect(await send(host, "1", b.id, 1)).toBeUndefined();
    expect(await send(host, "1", b.id, 2)).toBeUndefined(); // a retry of the same request
    now += 60_000;
    expect(await send(host, "2", b.id, 3)).toBeUndefined();
    // B replies to A: its own direction.
    const bHost = only(launched.slice(1));
    expect(await send(bHost, "r1", a.id, 1)).toBeUndefined();
    now += 60_000;
    expect(await send(host, "3", b.id, 4)).toBe("send_chat_message: you sent 2 messages to code-only-agent in the last 5 minutes; stop and report to the owner instead of retrying.");
    now += 3 * 60_000;
    expect(await send(host, "4", b.id, 5)).toBeUndefined();
    expect(bHost.requests.filter((request) => request.method === "chatMessage").map((request) => request.params?.["requestId"])).toEqual(["1", "2", "4"]);
  });

  it("allows 10 sends per sending chat in any hour across targets; retries do not count", async () => {
    let now = Date.parse("2026-11-24T10:00:00Z");
    const made = await service(() => target(), set, { now: () => now });
    await made.durable.start("/work/a");
    const host = only(made.launched);
    const targets = Array.from({ length: 6 }, (_, i) => made.locator.create(`/work/t${String(i)}`).id);
    let count = 0;
    const send = async (requestId: string, chat: string) => {
      host.push({ type: "durable.chat-message", requestId, chat, text: `msg ${requestId}`, wake: true });
      count += 1;
      await vi.waitFor(() => { expect(answered(host)).toHaveLength(count); });
      return answered(host)[count - 1]?.["error"];
    };
    for (let i = 0; i < 10; i++) {
      expect(await send(`s${String(i)}`, targets[Math.floor(i / 2)] ?? "")).toBeUndefined();
      now += 4 * 60_000;
    }
    expect(await send("s9", targets[4] ?? "")).toBeUndefined(); // a retry of the 10th
    expect(await send("s10", targets[5] ?? "")).toBe("send_chat_message: you sent 10 chat messages in the last hour; stop and report to the owner instead of retrying.");
    now = Date.parse("2026-11-24T10:00:00Z") + 60 * 60_000 + 1;
    expect(await send("s11", targets[5] ?? "")).toBeUndefined();
  });

  it("hop counter: a reply chain wakes through hop 5; hop 6 is a note without waking; an owner prompt resets it", async () => {
    let now = Date.parse("2026-11-24T10:00:00Z");
    const { durable, host, launched, a, b } = await pair({ now: () => now });
    const sent = new Map<FakeHost, number>();
    const send = async (from: FakeHost, requestId: string, chat: string, urgent?: boolean) => {
      from.push({ type: "durable.chat-message", requestId, chat, text: `msg ${requestId}`, wake: true, ...(urgent === undefined ? {} : { urgent }) });
      const count = (sent.get(from) ?? 0) + 1;
      sent.set(from, count);
      await vi.waitFor(() => { expect(answered(from)).toHaveLength(count); });
      now += 5 * 60_000;
      return answered(from).at(-1)?.["result"];
    };
    const delivered = (to: FakeHost) => to.requests.filter((request) => request.method === "chatMessage").at(-1)?.params;
    expect(await send(host, "h1", b.id)).toMatchObject({ hop: 1, delivery: "started" });
    const bHost = only(launched.slice(1));
    expect(await send(bHost, "h2", a.id, true)).toMatchObject({ hop: 2 });
    expect(delivered(host)).toMatchObject({ hop: 2, wake: true, urgent: true });
    expect(await send(host, "h3", b.id)).toMatchObject({ hop: 3 });
    expect(await send(bHost, "h4", a.id)).toMatchObject({ hop: 4 });
    expect(await send(host, "h5", b.id)).toMatchObject({ hop: 5, delivery: "started" });
    expect(delivered(bHost)).toMatchObject({ hop: 5, wake: true });
    const held = await send(bHost, "h6", a.id, true);
    expect(held).toEqual({ chatId: a.id, key: "cloud-builds-agents", name: "Cloud builds for agents", delivery: "noted", hop: 6, held: true });
    expect(delivered(host)).toMatchObject({ requestId: "h6", hop: 6, held: true, wake: false, urgent: false });
    // The owner prompts A: its chain restarts at hop 1.
    await durable.prompt({ id: a.id, cwd: a.cwd }, "owner here");
    expect(await send(host, "h7", b.id)).toMatchObject({ hop: 1 });
    expect(delivered(bHost)).toMatchObject({ hop: 1, wake: true });
  });

  it("keys and names come from the first message only as the host's redactor masks it, whole; no redactor gives the hex key", async () => {
    const token = "ghp_AbCdEf1234567890_secretTokenValue42";
    const redacting = () => { const host = target(); const answer = host.answer; host.answer = (request) => (request.method === "redact" ? String(request.params?.["text"]).replace(/ghp_[A-Za-z0-9_]+/gu, "[REDACTED:github-token]") : answer(request)); return host; };
    const made = await service(redacting, set);
    const a = await made.durable.start("/work/a");
    made.locator.update(a.id, { firstMessage: `${token} please rebase the branch` });
    const b = made.locator.create("/work/b");
    made.locator.update(b.id, { firstMessage: `${"x".repeat(50)} ${token} more words` });
    const host = only(made.launched);
    host.push({ type: "durable.chat-list", requestId: "l" });
    host.push({ type: "durable.chat-message", requestId: "m", chat: b.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(2); });
    const everything = JSON.stringify([answered(host), made.launched.flatMap((fake) => fake.requests.filter((request) => request.method !== "redact")), made.locator.all().map((record) => record.key)]);
    for (const piece of ["ghp", "abcdef", "secrettoken", "AbCdEf", "1234567890"]) expect(everything.toLowerCase()).not.toContain(piece.toLowerCase());
    expect(made.locator.durable(a.id)?.key).toBe("please-rebase-branch");
    expect(made.locator.durable(b.id)?.key).toBe("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-more-words");
    // A host that cannot redact: no first-message or title source at all.
    const old = await service(() => target("started", false), set);
    const c = await old.durable.start("/work/c");
    old.locator.update(c.id, { firstMessage: `${token} please rebase` });
    const d = old.locator.create("/work/d");
    old.locator.update(d.id, { name: "Code only agent" });
    only(old.launched).push({ type: "durable.chat-message", requestId: "m", chat: d.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(only(old.launched))).toHaveLength(1); });
    expect(old.locator.durable(c.id)?.key).toBe(`chat-${c.id.replace(/-/gu, "").slice(0, 8)}`);
    expect(old.locator.durable(d.id)?.key).toBe(`chat-${d.id.replace(/-/gu, "").slice(0, 8)}`);
    expect(old.launched[1]?.requests.find((request) => request.method === "chatMessage")?.params?.["from"]).toMatchObject({ name: "Durable Chat" });
    expect(answered(only(old.launched))[0]).toMatchObject({ result: { name: "Durable Chat" } });
  });

  it("two concurrent first sends from a keyless chat publish one key", async () => {
    const made = await service(() => target(), set);
    const a = await made.durable.start("/work/a");
    made.locator.update(a.id, { name: "Cloud builds agents" });
    const b = made.locator.create("/work/b");
    const c = made.locator.create("/work/c");
    const host = only(made.launched);
    host.push({ type: "durable.chat-message", requestId: "m1", chat: b.id, text: "hi", wake: true });
    host.push({ type: "durable.chat-message", requestId: "m2", chat: c.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(2); });
    for (const fake of made.launched.slice(1)) expect(fake.requests.find((request) => request.method === "chatMessage")?.params).toMatchObject({ from: { key: "cloud-builds-agents" } });
    expect(made.launched).toHaveLength(3);
    expect(made.locator.durable(a.id)?.key).toBe("cloud-builds-agents");
  });

  it("a failed send among concurrent ones gives back its quota", async () => {
    const made = await service(() => { const host = target(); const answer = host.answer; host.answer = (request) => { if (request.method === "chatMessage" && request.params?.["text"] === "fail") throw new Error("boom"); return answer(request); }; return host; }, set);
    await made.durable.start("/work/a");
    const b = made.locator.create("/work/b");
    const host = only(made.launched);
    host.push({ type: "durable.chat-message", requestId: "f", chat: b.id, text: "fail", wake: true });
    host.push({ type: "durable.chat-message", requestId: "o1", chat: b.id, text: "ok", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(2); });
    expect(answered(host).map((answer) => answer?.["error"])).toEqual(["boom", undefined]);
    host.push({ type: "durable.chat-message", requestId: "o2", chat: b.id, text: "ok", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(3); });
    expect(answered(host)[2]?.["error"]).toBeUndefined();
  });

  it("hop: a later low-hop note never lowers a chain; a refused or invalid owner prompt does not reset it, an admitted one does", async () => {
    let now = Date.parse("2026-11-24T10:00:00Z");
    const made = await service(() => target(), set, { now: () => now });
    const a = await made.durable.start("/work/a");
    const b = made.locator.create("/work/b");
    const c = made.locator.create("/work/c");
    const hosts = new Map<string, FakeHost>([[a.id, only(made.launched)]]);
    const sent = new Map<FakeHost, number>();
    const hostOf = (id: string) => { const host = hosts.get(id); if (host === undefined) throw new Error(`no host for ${id}`); return host; };
    const send = async (from: string, requestId: string, chat: string, wake = true) => {
      const host = hostOf(from);
      host.push({ type: "durable.chat-message", requestId, chat, text: `msg ${requestId}`, wake });
      const count = (sent.get(host) ?? 0) + 1;
      sent.set(host, count);
      await vi.waitFor(() => { expect(answered(host)).toHaveLength(count); });
      now += 5 * 60_000;
      return answered(host).at(-1);
    };
    const open = async (id: string, cwd: string) => { await made.durable.prompt({ id, cwd }, "owner here"); hosts.set(id, only(made.launched.slice(-1))); };
    await open(b.id, b.cwd);
    await open(c.id, c.cwd);
    for (let i = 1; i <= 4; i++) await send(i % 2 === 1 ? a.id : b.id, `h${String(i)}`, i % 2 === 1 ? b.id : a.id);
    expect(await send(a.id, "h5", b.id)).toMatchObject({ result: { hop: 5 } });
    // C, outside the chain, leaves B a note: B stays at hop 5.
    expect(await send(c.id, "n1", b.id, false)).toMatchObject({ result: { hop: 1, delivery: "noted" } });
    // An invalid owner prompt, then one B's host refuses: neither reached B, so neither resets its chain.
    await expect(made.durable.prompt({ id: b.id, cwd: b.cwd }, "")).rejects.toThrow(/non-empty/u);
    const bHost = hostOf(b.id);
    const answer = bHost.answer;
    bHost.answer = (request) => { if (request.method === "prompt") throw new Error("refused"); return answer(request); };
    await expect(made.durable.prompt({ id: b.id, cwd: b.cwd }, "owner here")).rejects.toThrow("refused");
    bHost.answer = answer;
    expect(await send(b.id, "h6", a.id)).toMatchObject({ result: { hop: 6, held: true } });
    await made.durable.prompt({ id: b.id, cwd: b.cwd }, "owner here");
    expect(await send(b.id, "h7", c.id)).toMatchObject({ result: { hop: 1 } });
  });

  it("a request older than an hour is forgotten: its retry reaches the target again, which answers it as the first", async () => {
    let now = Date.parse("2026-11-24T10:00:00Z");
    const { host, launched, b } = await pair({ now: () => now });
    host.push({ type: "durable.chat-message", requestId: "m", chat: b.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(1); });
    host.push({ type: "durable.chat-message", requestId: "m", chat: b.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(2); });
    const delivered = () => only(launched.slice(1)).requests.filter((request) => request.method === "chatMessage").length;
    expect(delivered()).toBe(1);
    now += 61 * 60_000;
    host.push({ type: "durable.chat-message", requestId: "m", chat: b.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(3); });
    expect(delivered()).toBe(2);
  });

  it("a paused target refuses at once: the sender is told by key, and nothing counts", async () => {
    const made = await service((n) => { const host = target(); if (n === 1) { const answer = host.answer; host.answer = (request) => { if (request.method === "chatMessage") throw new Error("The chat is paused until the owner resumes it; the message was not delivered"); return answer(request); }; } return host; }, set);
    await made.durable.start("/work/a");
    const b = made.locator.create("/work/b");
    made.locator.update(b.id, { name: "Code only agent" });
    const host = only(made.launched);
    for (const [index, wake] of [true, false].entries()) {
      host.push({ type: "durable.chat-message", requestId: `p${String(index)}`, chat: b.id, text: "hi", wake });
      await vi.waitFor(() => { expect(answered(host)).toHaveLength(index + 1); });
      expect(answered(host)[index]).toEqual({ requestId: `p${String(index)}`, error: "code-only-agent is paused until the owner resumes it; the message was not delivered" });
    }
    host.push({ type: "durable.chat-message", requestId: "p2", chat: b.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(3); });
    expect(answered(host)[2]?.["error"]).not.toMatch(/you sent 2 messages/u);
  });

  it("tells the sender when the target's host predates chat messages", async () => {
    const { host, b } = await (async () => {
      const made = await service((n) => {
        const fake = new FakeHost();
        if (n === 1) fake.answer = (request) => { if (request.method === "chatMessage") throw new Error("Unknown method chatMessage"); return request.method === "status" ? status : null; };
        return fake;
      }, set);
      await made.durable.start("/work/a");
      const b = made.locator.create("/work/b");
      return { host: only(made.launched), b };
    })();
    host.push({ type: "durable.chat-message", requestId: "m", chat: b.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(1); });
    expect(answered(host)[0]).toEqual({ requestId: "m", error: "The target chat's host is too old; upgrade its host" });
  });

  it("a title is used only as the host's redactor masks it, whole: in list, the header name and the key", async () => {
    const token = "ghp_AbCdEf1234567890_secretTokenValue42";
    const redacting = () => { const host = target(); const answer = host.answer; host.answer = (request) => (request.method === "redact" ? String(request.params?.["text"]).replace(/ghp_[A-Za-z0-9_]+/gu, "[REDACTED:github-token]") : answer(request)); return host; };
    const made = await service(redacting, set);
    const a = await made.durable.start("/work/a");
    made.locator.update(a.id, { name: `Fix ${token} deploy now` });
    const b = made.locator.create("/work/b");
    made.locator.update(b.id, { name: `Rotate ${token}-staging keys today` });
    const host = only(made.launched);
    host.push({ type: "durable.chat-list", requestId: "l" });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(1); });
    host.push({ type: "durable.chat-message", requestId: "m", chat: b.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answered(host)).toHaveLength(2); });
    const everything = JSON.stringify([answered(host), made.launched.flatMap((fake) => fake.requests.filter((request) => request.method !== "redact")), made.locator.all().map((record) => record.key)]);
    for (const piece of ["ghp", "abcdef", "secrettoken", "1234567890"]) expect(everything.toLowerCase()).not.toContain(piece);
    expect(made.locator.durable(a.id)?.key).toBe("fix-deploy-now");
    expect(made.locator.durable(b.id)?.key).toBe("rotate-staging-keys");
    expect(answered(host)[0]).toMatchObject({ result: { chats: [{ title: "Rotate -staging keys today" }] } });
    expect(made.launched[1]?.requests.find((request) => request.method === "chatMessage")?.params?.["from"]).toMatchObject({ name: "Fix deploy now" });
  });

  it("hop: a replayed owner prompt (the host admitted nothing new) or a host that does not say keeps the chain; a new one resets it", async () => {
    let now = Date.parse("2026-11-24T10:00:00Z");
    const { durable, host, launched, a, b } = await pair({ now: () => now });
    await durable.prompt({ id: b.id, cwd: b.cwd }, "owner here", undefined, undefined, { operationId: "op-1" });
    const bHost = only(launched.slice(1));
    const sent = new Map<FakeHost, number>();
    const send = async (from: FakeHost, requestId: string, chat: string) => {
      from.push({ type: "durable.chat-message", requestId, chat, text: `msg ${requestId}`, wake: true });
      const count = (sent.get(from) ?? 0) + 1;
      sent.set(from, count);
      await vi.waitFor(() => { expect(answered(from)).toHaveLength(count); });
      now += 5 * 60_000;
      return answered(from).at(-1)?.["result"];
    };
    for (let i = 1; i <= 4; i++) await send(i % 2 === 1 ? host : bHost, `h${String(i)}`, i % 2 === 1 ? b.id : a.id);
    expect(await send(host, "h5", b.id)).toMatchObject({ hop: 5 });
    await durable.prompt({ id: b.id, cwd: b.cwd }, "owner here", undefined, undefined, { operationId: "op-1" });
    expect(await send(bHost, "h6", a.id)).toMatchObject({ hop: 6, held: true });
    const answer = bHost.answer;
    bHost.answer = (request) => (request.method === "prompt" ? { submissionId: 9 } : answer(request));
    await durable.prompt({ id: b.id, cwd: b.cwd }, "owner here", undefined, undefined, { operationId: "op-old" });
    expect(await send(bHost, "h7", a.id)).toMatchObject({ hop: 6, held: true });
    bHost.answer = answer;
    await durable.prompt({ id: b.id, cwd: b.cwd }, "owner here", undefined, undefined, { operationId: "op-2" });
    expect(await send(bHost, "h8", a.id)).toMatchObject({ hop: 1 });
  });

  it("a replay the target answers as a duplicate keeps its first hop and held flag, and spends no quota", async () => {
    // As after a daemon restart: the target delivered these before, with what the daemon sent then.
    const first: Record<string, object> = { held: { delivery: "noted", hop: 6, held: true } };
    for (let i = 0; i < 10; i++) first[`old${String(i)}`] = { delivery: "started", hop: 2 };
    const made = await service(() => { const host = target(); const answer = host.answer; host.answer = (request) => { const earlier = request.method === "chatMessage" ? first[String(request.params?.["requestId"])] : undefined; return earlier === undefined ? answer(request) : { ...earlier, duplicate: true }; }; return host; }, set);
    await made.durable.start("/work/a");
    const b = made.locator.create("/work/b");
    const host = only(made.launched);
    let count = 0;
    const send = async (requestId: string, from = host) => {
      from.push({ type: "durable.chat-message", requestId, chat: from === host ? b.id : made.locator.all().find((record) => record.id !== b.id)?.id, text: `msg ${requestId}`, wake: true });
      count += 1;
      await vi.waitFor(() => { expect(answered(from)).toHaveLength(from === host ? count : 1); });
      return answered(from).at(-1);
    };
    expect(await send("held")).toMatchObject({ result: { delivery: "noted", hop: 6, held: true } });
    for (let i = 0; i < 10; i++) expect(await send(`old${String(i)}`)).toMatchObject({ result: { hop: 2 } });
    expect(await send("new")).toMatchObject({ result: { delivery: "started", hop: 1 } });
    // B is in the held chain: its own next send is held too.
    expect(await send("from-b", only(made.launched.slice(1)))).toMatchObject({ result: { hop: 7, held: true } });
  });
});

describe("Durable Chats: live review (/pair)", () => {
  const set: DurableChatResourceSet = { resources: { sources: [] }, compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 }, skillList: [] };
  /** Every host supports live review, takes chat messages (started), prompts (fresh), and redacts nothing. */
  const host = (_launch?: number, capabilities: string[] = ["liveReview"]) => {
    const fake = new FakeHost(DURABLE_HOST_PROTOCOL, capabilities);
    fake.answer = (request) => {
      if (request.method === "chatMessage") return { delivery: request.params?.["wake"] === false ? "noted" : "started" };
      if (request.method === "prompt") return { submissionId: 1, fresh: true };
      if (request.method === "redact") return String(request.params?.["text"]);
      return request.method === "status" ? status : null;
    };
    return fake;
  };
  const digests = (fake: FakeHost | undefined) => (fake?.requests ?? []).filter((request) => request.method === "chatMessage").map((request) => request.params);
  const edit = (path: string, newText: string) => ({ type: "message.end", message: { role: "assistant", content: [{ type: "text", text: `Editing ${path}` }, { type: "toolCall", id: path, name: "edit", arguments: { path, edits: [{ oldText: "i <= n", newText }] } }] } });
  const toolEnd = (toolName = "edit") => ({ type: "tool.end", toolName, toolCallId: "t", text: "Successfully replaced text. TOOL-OUTPUT", isError: false });

  async function paired(args = "", extra: Partial<ConstructorParameters<typeof DurableChatService>[0]> = {}, existing?: { root: string }) {
    const made = existing === undefined ? await service(host, set, extra) : await reopen(existing.root, extra);
    const main = await made.durable.start("/work/a");
    made.locator.update(main.id, { name: "Cloud builds for agents" });
    const ref = { id: main.id, cwd: main.cwd };
    const result = await made.durable.runCommand(ref, `/pair ${args}`);
    return { ...made, main, ref, result, mainHost: only(made.launched), reviewerHost: made.launched[1] };
  }

  /** A second daemon over the same records and stores, as after a restart. */
  function reopen(root: string, extra: Partial<ConstructorParameters<typeof DurableChatService>[0]> = {}) {
    const hub = new SessionEventHub();
    const locator = new SessionRuntimeLocator(root);
    const launched: FakeHost[] = [];
    const durable = new DurableChatService({ locator, events: hub, launch: () => { const fake = host(); launched.push(fake); return fake; }, storesDir: join(root, "durable"), resources: () => Promise.resolve(set), ...extra });
    return Promise.resolve({ durable, hub, locator, launched, root, unread: [] });
  }

  it("/pair starts a reviewer chat in the same workspace on Sol at thinking low, names it, and records the pairing and its knobs in both records", async () => {
    const { durable, locator, root, main, result, reviewerHost } = await paired();
    const reviewer = only(locator.all().filter((record) => record.id !== main.id));
    expect(reviewer.cwd).toBe("/work/a");
    expect(reviewer.name).toBe("Live review · Cloud builds for agents");
    expect(reviewerHost?.requests.find((request) => request.method === "setModel")?.params).toEqual({ provider: "openai", modelId: "gpt-6.2-sol" });
    expect(reviewerHost?.requests.find((request) => request.method === "setThinkingLevel")?.params).toEqual({ level: "low" });
    expect(reviewerHost?.requests.some((request) => request.method === "prompt")).toBe(false);
    const reread = new SessionRuntimeLocator(root);
    expect(reread.durable(main.id)?.liveReview).toMatchObject({ reviewerId: reviewer.id, model: "openai/gpt-6.2-sol", thinking: "low", trigger: "turn5", brief: "silent", turn: 0, digests: 0 });
    expect(reread.durable(reviewer.id)?.reviewing).toBe(main.id);
    expect(result).toEqual({ type: "done", message: 'Live review on: "Live review · Cloud builds for agents" reviews this chat with openai/gpt-6.2-sol at thinking low, trigger turn5, brief silent. /pair stop ends it.' });
    expect((await durable.commands({ id: main.id, cwd: main.cwd })).map((command) => command.name)).toContain("pair");
  });

  it("turn5: a digest after 5 finished tool calls holds the edit's arguments and no tool output; while the reviewer is busy the next ones merge, then go at its turn end", async () => {
    const { mainHost, reviewerHost, main } = await paired("--brief coach");
    mainHost.push({ type: "agent.start" });
    mainHost.push({ type: "message.end", message: { role: "user", content: [{ type: "text", text: "Sum the list" }] } });
    mainHost.push(edit("src/sum.ts", "i < n - 1"));
    for (let i = 0; i < 4; i++) mainHost.push(toolEnd());
    await new Promise((resolve) => setImmediate(resolve));
    expect(digests(reviewerHost)).toHaveLength(0);
    mainHost.push(toolEnd());
    await vi.waitFor(() => { expect(digests(reviewerHost)).toHaveLength(1); });
    const first = digests(reviewerHost)[0];
    expect(first).toMatchObject({ requestId: "live-review-digest-1", from: { chatId: main.id, key: "cloud-builds-agents", name: "Cloud builds for agents" }, wake: true, urgent: false, liveReview: { kind: "digest", turn: 1, trigger: "turn5", brief: "coach" } });
    expect(first?.["text"]).toBe('Owner: Sum the list\nAssistant: Editing src/sum.ts\nTool call edit {"path":"src/sum.ts","edits":[{"oldText":"i <= n","newText":"i < n - 1"}]}\nFiles touched: src/sum.ts');
    expect(JSON.stringify(digests(reviewerHost))).not.toContain("TOOL-OUTPUT");
    // The reviewer is still on digest 1: the next 5 calls and the turn end wait, merged into one.
    mainHost.push(edit("src/a.ts", "a"));
    for (let i = 0; i < 5; i++) mainHost.push(toolEnd());
    mainHost.push(edit("src/b.ts", "b"));
    mainHost.push({ type: "agent.end" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(digests(reviewerHost)).toHaveLength(1);
    reviewerHost?.push({ type: "agent.end" });
    await vi.waitFor(() => { expect(digests(reviewerHost)).toHaveLength(2); });
    expect(digests(reviewerHost)[1]).toMatchObject({ requestId: "live-review-digest-2", liveReview: { kind: "digest", turn: 1 } });
    expect(String(digests(reviewerHost)[1]?.["text"])).toMatch(/src\/a\.ts[\s\S]*src\/b\.ts[\s\S]*Files touched: src\/b\.ts, src\/a\.ts$/);
  });

  it("the trigger knob: turn sends only at the turn end; edits after every edit call", async () => {
    const turn = await paired("--trigger turn");
    turn.mainHost.push({ type: "agent.start" });
    turn.mainHost.push(edit("x.ts", "1"));
    for (let i = 0; i < 6; i++) turn.mainHost.push(toolEnd());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(digests(turn.reviewerHost)).toHaveLength(0);
    turn.mainHost.push({ type: "agent.end" });
    await vi.waitFor(() => { expect(digests(turn.reviewerHost)).toHaveLength(1); });
    expect(digests(turn.reviewerHost)[0]).toMatchObject({ liveReview: { trigger: "turn", brief: "silent" } });
    const edits = await paired("--trigger edits");
    edits.mainHost.push({ type: "agent.start" });
    edits.mainHost.push(edit("y.ts", "1"));
    edits.mainHost.push(toolEnd("read"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(digests(edits.reviewerHost)).toHaveLength(0);
    edits.mainHost.push(toolEnd("edit"));
    await vi.waitFor(() => { expect(digests(edits.reviewerHost)).toHaveLength(1); });
  });

  it("the pairing survives a daemon restart: turn and digest numbers continue", async () => {
    const first = await paired("--trigger turn");
    first.mainHost.push({ type: "agent.start" });
    first.mainHost.push(edit("x.ts", "1"));
    first.mainHost.push({ type: "agent.end" });
    await vi.waitFor(() => { expect(digests(first.reviewerHost)).toHaveLength(1); });
    const reviewerId = first.locator.durable(first.main.id)?.liveReview?.reviewerId ?? "";
    await first.durable.dispose();
    const second = await reopen(first.root);
    const ref = { id: first.main.id, cwd: "/work/a" };
    await second.durable.status(ref);
    const mainHost = only(second.launched);
    mainHost.push({ type: "agent.start" });
    mainHost.push(edit("z.ts", "2"));
    mainHost.push({ type: "agent.end" });
    await vi.waitFor(() => { expect(second.launched).toHaveLength(2); });
    await vi.waitFor(() => { expect(digests(second.launched[1])).toHaveLength(1); });
    expect(digests(second.launched[1])[0]).toMatchObject({ requestId: "live-review-digest-2", liveReview: { kind: "digest", turn: 2, trigger: "turn" } });
    expect(second.locator.durable(ref.id)?.liveReview?.reviewerId).toBe(reviewerId);
  });

  it("/pair stop ends it and the reviewer chat stays; no pairing twice, none from a reviewer, a usage error for bad arguments", async () => {
    const { durable, locator, main, ref, mainHost, reviewerHost } = await paired();
    const reviewerId = locator.durable(main.id)?.liveReview?.reviewerId ?? "";
    await expect(durable.runCommand(ref, "/pair")).resolves.toEqual({ type: "unsupported", message: 'This chat already has a live reviewer, "Live review · Cloud builds for agents"; /pair stop ends it first.' });
    await expect(durable.runCommand({ id: reviewerId, cwd: "/work/a" }, "/pair")).resolves.toEqual({ type: "unsupported", message: "This chat is a live reviewer; it cannot have one." });
    await expect(durable.runCommand(ref, "/pair --trigger often")).resolves.toEqual({ type: "unsupported", message: "Usage: /pair [<provider/model>] [--trigger turn|turn5|edits] [--brief silent|coach], or /pair stop" });
    await expect(durable.runCommand(ref, "/pair stop")).resolves.toEqual({ type: "done", message: 'Live review stopped; "Live review · Cloud builds for agents" stays readable.' });
    expect(locator.durable(main.id)?.liveReview).toBeUndefined();
    expect(locator.durable(reviewerId)?.reviewing).toBeUndefined();
    expect(locator.durable(reviewerId)).toBeDefined();
    mainHost.push({ type: "agent.start" });
    mainHost.push(edit("x.ts", "1"));
    mainHost.push({ type: "agent.end" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(digests(reviewerHost)).toHaveLength(0);
    await expect(durable.runCommand(ref, "/pair stop")).resolves.toEqual({ type: "unsupported", message: "This chat has no live reviewer." });
  });

  it("an agent cannot start a pairing: a spawned chat's prompt and a chat message reading /pair are plain text", async () => {
    const resolveSpawnTarget = () => Promise.resolve({ allowed: true as const, cwd: "/work/a" });
    const made = await service(host, set, { spawnTargets: { resolveSpawnTarget } });
    const lead = await made.durable.start("/work/a");
    const lead$ = only(made.launched);
    lead$.push({ type: "durable.spawn", requestId: "s", spawningCwd: "/work/a", prompt: "/pair" });
    await vi.waitFor(() => { expect(lead$.requests.some((request) => request.method === "spawned")).toBe(true); });
    const child = only(made.locator.all().filter((record) => record.id !== lead.id));
    expect(made.launched[1]?.requests.find((request) => request.method === "prompt")?.params).toMatchObject({ text: "/pair" });
    lead$.push({ type: "durable.chat-message", requestId: "m", chat: child.id, text: "/pair", wake: true });
    await vi.waitFor(() => { expect(lead$.requests.some((request) => request.method === "chatMessaged")).toBe(true); });
    expect(made.locator.all()).toHaveLength(2);
    expect(made.locator.all().every((record) => record.liveReview === undefined && record.reviewing === undefined)).toBe(true);
  });

  it("the reviewer's messages to its main chat are exempt from both limits and the hop counter, and say they come from the live reviewer", async () => {
    let now = Date.parse("2026-11-24T10:00:00Z");
    const { locator, main, mainHost, reviewerHost } = await paired("", { now: () => now });
    const other = locator.create("/work/b");
    const answers = (fake: FakeHost | undefined) => (fake?.requests ?? []).filter((request) => request.method === "chatMessaged").map((request) => request.params);
    for (let i = 0; i < 12; i++) {
      reviewerHost?.push({ type: "durable.chat-message", requestId: `r${String(i)}`, chat: "cloud-builds-agents", text: `finding ${String(i)}`, wake: true, urgent: true });
      await vi.waitFor(() => { expect(answers(reviewerHost)).toHaveLength(i + 1); });
      now += 1000;
    }
    expect(answers(reviewerHost).every((answer) => answer?.["error"] === undefined)).toBe(true);
    expect(answers(reviewerHost)[0]).toEqual({ requestId: "r0", result: { chatId: main.id, key: "cloud-builds-agents", name: "Cloud builds for agents", delivery: "started" } });
    const delivered = digests(mainHost);
    expect(delivered).toHaveLength(12);
    expect(delivered[0]).toMatchObject({ requestId: "r0", wake: true, urgent: true, liveReview: { kind: "reviewer" } });
    expect(delivered[0]).not.toHaveProperty("hop");
    // The main chat's own chain is untouched: its next message elsewhere is hop 1.
    mainHost.push({ type: "durable.chat-message", requestId: "m", chat: other.id, text: "hi", wake: true });
    await vi.waitFor(() => { expect(answers(mainHost)).toHaveLength(1); });
    expect(answers(mainHost)[0]).toMatchObject({ result: { hop: 1 } });
  });

  /** The main Chat runs one turn: its first input, an edit and 5 finished tool calls, then the turn end. */
  const turn = (fake: FakeHost, input: object) => {
    fake.push({ type: "agent.start" });
    fake.push(input);
    fake.push(edit("src/sum.ts", "i < n"));
    for (let i = 0; i < 5; i++) fake.push(toolEnd());
    fake.push({ type: "agent.end" });
  };
  const ownerPrompt = (text: string) => ({ type: "message.end", message: { role: "user", content: [{ type: "text", text }] } });
  const fromReviewer = (delivery: string) => ({ type: "message.end", message: { role: "custom", customType: "workbench:chat-message", content: "Chat message · live reviewer", details: { delivery, liveReview: { kind: "reviewer" } } } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("no runaway loop: a reviewer that answers every digest and a main that answers every finding stop after one round", async () => {
    const { mainHost, reviewerHost } = await paired();
    if (reviewerHost === undefined) throw new Error("no reviewer host");
    const [mainAnswer, reviewerAnswer] = [mainHost.answer, reviewerHost.answer];
    let findings = 0;
    // The reviewer sends one normal finding per digest (at most 6, so a loop ends the test instead of running forever).
    reviewerHost.answer = (request) => {
      if (request.method === "chatMessage" && findings++ < 6) setTimeout(() => {
        reviewerHost.push({ type: "agent.start" });
        reviewerHost.push({ type: "durable.chat-message", requestId: `f${String(findings)}`, chat: "cloud-builds-agents", text: "src/sum.ts:1 off by one", wake: true });
        reviewerHost.push({ type: "agent.end" });
      }, 1);
      return reviewerAnswer(request);
    };
    // The main Chat is idle, so each finding starts a turn, which answers it with more edits.
    mainHost.answer = (request) => {
      if (request.method === "chatMessage") setTimeout(() => { turn(mainHost, fromReviewer("started")); }, 1);
      return mainAnswer(request);
    };
    turn(mainHost, ownerPrompt("Sum the list"));
    await vi.waitFor(() => { expect(digests(mainHost)).toHaveLength(1); });
    await settle();
    expect(digests(reviewerHost)).toHaveLength(1);
    expect(digests(mainHost)).toHaveLength(1);
    // The owner's next turn digests again, and holds the main Chat's answer to the finding.
    turn(mainHost, ownerPrompt("Now the average"));
    await vi.waitFor(() => { expect(digests(reviewerHost)).toHaveLength(2); });
    expect(String(digests(reviewerHost)[1]?.["text"])).toMatch(/^Assistant: Editing src\/sum\.ts[\s\S]*Owner: Now the average/u);
  });

  it("a reviewer steer into the owner's turn keeps that turn's digests", async () => {
    const { mainHost, reviewerHost } = await paired();
    mainHost.push({ type: "agent.start" });
    mainHost.push(ownerPrompt("Sum the list"));
    for (let i = 0; i < 5; i++) mainHost.push(toolEnd());
    await vi.waitFor(() => { expect(digests(reviewerHost)).toHaveLength(1); });
    reviewerHost?.push({ type: "agent.end" });
    mainHost.push(fromReviewer("steered"));
    mainHost.push(edit("src/sum.ts", "i < n"));
    for (let i = 0; i < 5; i++) mainHost.push(toolEnd());
    await vi.waitFor(() => { expect(digests(reviewerHost)).toHaveLength(2); });
  });

  it("each field goes through the main chat host's redactor whole, before the digest cuts or escapes it; without a redactor it is omitted", async () => {
    /** Built from parts, so the commit secret scanner sees no key block. */
    const pemEdge = (edge: string) => `-----${edge} ${["PRIVATE", "KEY"].join(" ")}-----`;
    const pem = `${pemEdge("BEGIN")}\n${"QUJD".repeat(10_000)}\n${pemEdge("END")}`;
    const secret = "tok\\en-s3cr3t";
    const redacting = (launch: number) => {
      const fake = host(launch);
      const base = fake.answer;
      fake.answer = (request) => request.method === "redact"
        ? String(request.params?.["text"]).replace(new RegExp(`${pemEdge("BEGIN")}[\\s\\S]*?${pemEdge("END")}`, "gu"), "[REDACTED:private-key]").replaceAll(secret, "[REDACTED:token]")
        : base(request);
      return fake;
    };
    const made = await service(redacting, set);
    const main = await made.durable.start("/work/a");
    await made.durable.runCommand({ id: main.id, cwd: main.cwd }, "/pair --trigger turn");
    const mainHost = only(made.launched);
    mainHost.push({ type: "agent.start" });
    mainHost.push(ownerPrompt(`Use ${secret}`));
    mainHost.push({ type: "message.end", message: { role: "assistant", content: [{ type: "toolCall", id: "w", name: "write", arguments: { path: "id_rsa", content: pem } }] } });
    mainHost.push({ type: "agent.end" });
    await vi.waitFor(() => { expect(digests(made.launched[1])).toHaveLength(1); });
    const text = String(digests(made.launched[1])[0]?.["text"]);
    expect(text).toBe('Owner: Use [REDACTED:token]\nTool call write {"path":"id_rsa","content":"[REDACTED:private-key]"}\nFiles touched: id_rsa');
    // A main host that cannot redact: each field is left out.
    const blind = await paired("--trigger turn");
    const base = blind.mainHost.answer;
    blind.mainHost.answer = (request) => { if (request.method === "redact") throw new Error("Unknown method redact"); return base(request); };
    blind.mainHost.push({ type: "agent.start" });
    blind.mainHost.push(ownerPrompt(`Use ${secret}`));
    blind.mainHost.push({ type: "agent.end" });
    await vi.waitFor(() => { expect(digests(blind.reviewerHost)).toHaveLength(1); });
    expect(digests(blind.reviewerHost)[0]?.["text"]).toBe("Owner: [redaction unavailable: omitted]");
  });

  it("two /pair at once start one reviewer; a /pair stop right behind a /pair ends the pairing it started", async () => {
    const made = await service(host, set);
    const main = await made.durable.start("/work/a");
    made.locator.update(main.id, { name: "Cloud builds for agents" });
    const ref = { id: main.id, cwd: main.cwd };
    const results = await Promise.all([made.durable.runCommand(ref, "/pair"), made.durable.runCommand(ref, "/pair")]);
    expect(results.map((result) => result.type).sort()).toEqual(["done", "unsupported"]);
    const reviewers = made.locator.all().filter((record) => record.id !== main.id);
    expect(reviewers).toHaveLength(1);
    expect(made.locator.durable(main.id)?.liveReview?.reviewerId).toBe(reviewers[0]?.id);
    await made.durable.runCommand(ref, "/pair stop");
    const [started, stopped] = await Promise.all([made.durable.runCommand(ref, "/pair"), made.durable.runCommand(ref, "/pair stop")]);
    expect([started.type, stopped.type]).toEqual(["done", "done"]);
    expect(made.locator.durable(main.id)?.liveReview).toBeUndefined();
    expect(made.locator.all().every((record) => record.reviewing === undefined)).toBe(true);
  });

  it("ending either chat explicitly unlinks the pair and drops its pending digest; the next main turn relaunches no reviewer", async () => {
    const endReviewer = await paired("--trigger turn");
    const reviewerId = endReviewer.locator.durable(endReviewer.main.id)?.liveReview?.reviewerId ?? "";
    // A digest waits for the busy reviewer.
    turn(endReviewer.mainHost, ownerPrompt("Sum the list"));
    await vi.waitFor(() => { expect(digests(endReviewer.reviewerHost)).toHaveLength(1); });
    turn(endReviewer.mainHost, ownerPrompt("Again"));
    await endReviewer.durable.stop({ id: reviewerId, cwd: "/work/a" });
    expect(endReviewer.locator.durable(endReviewer.main.id)?.liveReview).toBeUndefined();
    expect(endReviewer.locator.durable(reviewerId)?.reviewing).toBeUndefined();
    turn(endReviewer.mainHost, ownerPrompt("Once more"));
    await settle();
    expect(endReviewer.launched).toHaveLength(2);
    expect(digests(endReviewer.reviewerHost)).toHaveLength(1);
    await expect(endReviewer.durable.runCommand(endReviewer.ref, "/pair stop")).resolves.toEqual({ type: "unsupported", message: "This chat has no live reviewer." });

    const endMain = await paired("--trigger turn");
    const otherReviewer = endMain.locator.durable(endMain.main.id)?.liveReview?.reviewerId ?? "";
    await endMain.durable.stopIfUnwatched(endMain.ref, true);
    expect(endMain.locator.durable(endMain.main.id)?.liveReview).toBeUndefined();
    expect(endMain.locator.durable(otherReviewer)?.reviewing).toBeUndefined();
    expect(endMain.locator.durable(otherReviewer)).toBeDefined();
  });

  it("an explicit end of the main chat while its reviewer is starting leaves no pair behind", async () => {
    let held: Request | undefined;
    const made = await service((launch) => {
      const fake = host(launch);
      const answer = fake.answer;
      if (launch === 1) fake.answer = (request) => (request.method === "setThinkingLevel" ? ((held = request), NO_REPLY) : answer(request));
      return fake;
    }, set);
    const main = await made.durable.start("/work/a");
    const ref = { id: main.id, cwd: main.cwd };
    const pairing = made.durable.runCommand(ref, "/pair");
    await vi.waitFor(() => { expect(held).toBeDefined(); });
    const ended = made.durable.stop(ref);
    await settle();
    made.launched[1]?.emit("message", { id: held?.id, result: null });
    await Promise.all([pairing, ended]);
    expect(made.locator.durable(main.id)?.liveReview).toBeUndefined();
    expect(made.locator.all().every((record) => record.reviewing === undefined)).toBe(true);
  });

  it("ending a reviewer that /pair stop already replaced leaves the replacement pair", async () => {
    const { durable, locator, main, ref } = await paired("--trigger turn");
    const oldReviewer = locator.durable(main.id)?.liveReview?.reviewerId ?? "";
    const stopped = durable.runCommand(ref, "/pair stop");
    const started = durable.runCommand(ref, "/pair");
    const ended = durable.stop({ id: oldReviewer, cwd: "/work/a" });
    await Promise.all([stopped, started, ended]);
    const replacement = locator.durable(main.id)?.liveReview?.reviewerId;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(oldReviewer);
    expect(locator.durable(replacement ?? "")?.reviewing).toBe(main.id);
    expect(locator.durable(oldReviewer)?.reviewing).toBeUndefined();
  });

  it("a routine idle close of both hosts keeps the pair", async () => {
    let now = Date.parse("2026-11-17T08:00:00Z");
    const { durable, locator, main, launched } = await paired("--trigger turn", { now: () => now });
    const reviewerId = locator.durable(main.id)?.liveReview?.reviewerId ?? "";
    now += IDLE_HOST_CLOSE_MS;
    await durable.closeIdleHosts();
    expect(launched.every((fake) => fake.requests.some((request) => request.method === "close"))).toBe(true);
    expect(locator.durable(main.id)?.liveReview?.reviewerId).toBe(reviewerId);
    expect(locator.durable(reviewerId)?.reviewing).toBe(main.id);
  });

  it("/pair refuses unless both hosts support live review; /pair stop works on any host", async () => {
    const oldMain = await service((launch) => host(launch, []), set);
    const main = await oldMain.durable.start("/work/a");
    await expect(oldMain.durable.runCommand({ id: main.id, cwd: main.cwd }, "/pair")).resolves.toEqual({ type: "unsupported", message: "Live review needs this chat's host to support it: upgrade host, then /pair again." });
    expect(oldMain.locator.all()).toHaveLength(1);
    const oldReviewer = await service((launch) => host(launch, launch === 0 ? ["liveReview"] : []), set);
    const main2 = await oldReviewer.durable.start("/work/a");
    await expect(oldReviewer.durable.runCommand({ id: main2.id, cwd: main2.cwd }, "/pair")).resolves.toEqual({ type: "unsupported", message: "Live review needs the reviewer chat's host to support it: upgrade host, then /pair again." });
    expect(oldReviewer.locator.all().map((record) => record.id)).toEqual([main2.id]);
    expect(oldReviewer.locator.durable(main2.id)?.liveReview).toBeUndefined();
    // A pairing whose hosts went back to an old version still stops.
    const first = await paired();
    await first.durable.dispose();
    const second = await reopen(first.root);
    second.durable = new DurableChatService({ locator: second.locator, events: second.hub, launch: () => { const fake = host(0, []); second.launched.push(fake); return fake; }, storesDir: join(first.root, "durable"), resources: () => Promise.resolve(set) });
    await expect(second.durable.runCommand(first.ref, "/pair stop")).resolves.toMatchObject({ type: "done" });
    expect(second.locator.durable(first.main.id)?.liveReview).toBeUndefined();
  });
});

/** A Chat-title request, as opposed to a tab-name one. */
function isTitleRequest(request: { method: string; params?: Record<string, unknown> }): boolean {
  return request.method === "complete" && String(request.params?.["prompt"]).startsWith("Create a 2-6 word title");
}

describe("the owner's run button", () => {
  /** A Chat whose assistant message `a1` proposes `command` in `cwd`, on a host with `capabilities`; `ownerRun` answers as `launch`. */
  async function proposing(command: string, { capabilities = ["owner-run"], launch = () => ({ jobId: "job-1", logPath: "/jobs/job-1/output.log" }) }: { capabilities?: string[]; launch?: () => unknown } = {}) {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-web-owner-run-")));
    roots.push(cwd);
    const text = `Run it:\n\n\`\`\`pi-run cwd="${cwd}"\n${command}\n\`\`\`\n`;
    const answer = (request: Request) => request.method === "transcript" ? { messages: [{ entryId: "a1", role: "assistant", content: [{ type: "text", text }] }], partial: null, status }
      : request.method === "ownerRun" ? launch() : request.method === "status" ? status : null;
    const made = await service(() => { const host = new FakeHost(DURABLE_HOST_PROTOCOL, capabilities); host.answer = answer; return host; });
    const chat = await made.durable.start(cwd);
    return { ...made, ref: { id: chat.id, cwd: chat.cwd }, cwd, proposal: { mode: "run", cwd, command } };
  }
  const runs = (launched: FakeHost[]) => launched.flatMap((host) => host.requests.filter((request) => request.method === "ownerRun"));

  it("two confirmations at once start it once, as the host's background job: the guarded script in its folder, named by the proposal", async () => {
    const { durable, launched, ref, proposal, cwd } = await proposing("pwd; exit 7");
    const results = await Promise.allSettled([durable.ownerRun(ref, "a1", proposal), durable.ownerRun(ref, "a1", proposal)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "fulfilled")).toEqual({ status: "fulfilled", value: { status: "started" } });
    const [run, ...more] = runs(launched);
    expect(more).toEqual([]);
    expect(run?.params).toMatchObject({ cwd, command: `cd -P -- '${cwd}' && [ "$PWD" = '${cwd}' ] || { echo "pi-run: the folder changed after it was checked" >&2; exit 125; }\npwd; exit 7\n` });
    expect(run?.params?.operationId).toEqual(expect.stringMatching(/^owner-run:[0-9a-f]{32}$/));
    // The agent learns the result from the job's completion, not from a prompt of PI WEB's.
    expect(launched.flatMap((host) => host.requests.filter((request) => request.method === "prompt"))).toEqual([]);
  });

  it("refuses a host without run buttons before anything starts", async () => {
    const { durable, launched, ref, proposal } = await proposing("true", { capabilities: [] });
    await expect(durable.ownerRun(ref, "a1", proposal)).rejects.toThrow("Run buttons");
    expect(runs(launched)).toEqual([]);
  });

  it("a launch the host refused can be confirmed again, under the same operation", async () => {
    let refuse = true;
    const { durable, launched, ref, proposal } = await proposing("true", { launch: () => { if (refuse) throw new Error("Working directory does not exist"); return { jobId: "job-1" }; } });
    await expect(durable.ownerRun(ref, "a1", proposal)).rejects.toThrow("Working directory does not exist");
    refuse = false;
    await expect(durable.ownerRun(ref, "a1", proposal)).resolves.toEqual({ status: "started" });
    const [first, second] = runs(launched);
    expect(second?.params?.["operationId"]).toBe(first?.params?.["operationId"]);
  });
});
