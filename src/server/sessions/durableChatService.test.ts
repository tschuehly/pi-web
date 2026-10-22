import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { DURABLE_HOST_PROTOCOL, DurableChatService, type DurableHostProcess } from "./durableChatService.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";

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

  constructor(protocol = DURABLE_HOST_PROTOCOL) {
    super();
    queueMicrotask(() => { this.emit("message", { ready: { protocol } }); });
  }

  send(message: unknown): boolean {
    if (!isRequest(message)) throw new Error("not a host request");
    const request = message;
    this.requests.push(request);
    queueMicrotask(() => { this.emit("message", { id: request.id, result: this.answer(request) }); });
    return true;
  }

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

async function service(make: (launch: number) => FakeHost = () => new FakeHost()): Promise<{ durable: DurableChatService; hub: SessionEventHub; locator: SessionRuntimeLocator; launched: FakeHost[]; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-durable-"));
  roots.push(root);
  const hub = new SessionEventHub();
  const locator = new SessionRuntimeLocator(root);
  const launched: FakeHost[] = [];
  const durable = new DurableChatService({
    locator,
    events: hub,
    launch: () => { const host = make(launched.length); launched.push(host); return host; },
    storesDir: join(root, "durable"),
  });
  return { durable, hub, locator, launched, root };
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
    await expect(durable.start("/work/a")).rejects.toThrow(/protocol 2, this daemon 1/);
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
    expect(global).toContainEqual({ type: "status.update", status: { ...status, messageCount: 1, sessionId: chat.id } });
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
    await expect(durable.prompt(ref, "with image", undefined, [{ name: "a.png" }])).rejects.toThrow(/Attachments is not available in Durable Chats yet/);
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
});
