import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { ClientSession } from "../types.js";
import { DURABLE_HOST_PROTOCOL, DurableChatService, type DurableHostProcess } from "./durableChatService.js";
import { createRuntimeRoutedSessionService } from "./runtimeRoutedSessionService.js";
import type { SessionRouteService } from "./sessionService.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";

const legacyChat: ClientSession = { id: "legacy-1", cwd: "/work/a", path: "/sessions/legacy-1.jsonl", created: "2026-10-01T00:00:00.000Z", modified: "2026-10-01T00:00:00.000Z", messageCount: 2, firstMessage: "old" };

/** The legacy service as the router sees it: every call recorded, every answer canned. */
function legacyService(): { service: SessionRouteService; calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    list: [legacyChat],
    listRecent: [legacyChat],
    start: legacyChat,
    locate: { cwd: "/work/a" },
    notificationCatalog: { daemonInstanceId: "daemon-1", catalogRevision: 4, sessions: [] },
  };
  const handler: ProxyHandler<object> = {
    get: (_target, name: string) => (...args: unknown[]) => {
      calls.push(`${name}${name === "start" ? JSON.stringify(args[1] ?? null) : ""}`);
      return Promise.resolve(answers[name]);
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a recording double of the whole route contract.
  const service = new Proxy({}, handler) as SessionRouteService;
  return { service, calls };
}

class ReadyHost extends EventEmitter implements DurableHostProcess {
  readonly methods: string[] = [];
  constructor() {
    super();
    queueMicrotask(() => { this.emit("message", { ready: { protocol: DURABLE_HOST_PROTOCOL } }); });
  }
  send(message: unknown): boolean {
    if (typeof message !== "object" || message === null || !("id" in message) || !("method" in message) || typeof message.method !== "string") return false;
    const { id, method } = message;
    this.methods.push(method);
    queueMicrotask(() => { this.emit("message", { id, result: method === "status" ? { isStreaming: false, queuedMessages: [], pendingMessageCount: 0 } : null }); });
    return true;
  }
  kill(): boolean { return true; }
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function router() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-routed-"));
  roots.push(root);
  const legacy = legacyService();
  const hosts: ReadyHost[] = [];
  const durable = new DurableChatService({
    locator: new SessionRuntimeLocator(root),
    events: new SessionEventHub(),
    launch: () => { const host = new ReadyHost(); hosts.push(host); return host; },
    storesDir: join(root, "durable"),
  });
  return { routed: createRuntimeRoutedSessionService(legacy.service, durable), calls: legacy.calls, hosts };
}

describe("runtime-routed session service", () => {
  it("creates legacy Chats by default and a Durable Chat only when asked", async () => {
    const { routed, calls, hosts } = await router();
    await expect(routed.start("/work/a")).resolves.toBe(legacyChat);
    await expect(routed.start("/work/a", { startupToken: "t-1" })).resolves.toBe(legacyChat);
    expect(calls).toEqual(["startnull", 'start{"startupToken":"t-1"}']);
    expect(hosts).toHaveLength(0);
    const durableChat = await routed.start("/work/a", { runtime: "durable", startupToken: "t-2" });
    expect(durableChat).toMatchObject({ cwd: "/work/a", startupToken: "t-2" });
    expect(hosts).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("routes each Chat's operations by its locator: legacy ids to legacy, Durable ids to their host", async () => {
    const { routed, calls, hosts } = await router();
    const durableChat = await routed.start("/work/a", { runtime: "durable" });
    await routed.prompt({ id: legacyChat.id, cwd: "/work/a" }, "to legacy");
    await routed.abort({ id: legacyChat.id, cwd: "/work/a" });
    await routed.prompt({ id: durableChat.id, cwd: "/work/a" }, "to durable");
    await routed.status({ id: durableChat.id, cwd: "/work/a" });
    await routed.abort({ id: durableChat.id, cwd: "/work/a" });
    expect(calls).toEqual(["prompt", "abort"]);
    expect(hosts[0]?.methods).toEqual(["prompt", "status", "abort"]);
  });

  it("rejects operations Durable Chats do not support yet without touching the legacy runtime", async () => {
    const { routed, calls } = await router();
    const ref = await routed.start("/work/a", { runtime: "durable" });
    await expect(Promise.resolve().then(() => routed.setModel(ref, "anthropic", "claude-opus-5-5"))).rejects.toThrow("Switching models is not available in Durable Chats yet");
    await expect(Promise.resolve().then(() => routed.submitAsk(ref, "q-1", { answers: [] }))).rejects.toThrow(/not available in Durable Chats yet/);
    expect(routed.attentionRequest(ref)).toBeUndefined();
    await expect(routed.openAsks(ref)).resolves.toEqual([]);
    await expect(routed.notificationInbox(ref)).resolves.toMatchObject({ daemonInstanceId: "daemon-1", notifications: [] });
    expect(calls).toEqual(["notificationCatalog"]);
  });

  it("lists both runtimes per workspace, answers a targeted Durable lookup itself and locates Durable Chats", async () => {
    const { routed } = await router();
    const durableChat = await routed.start("/work/a", { runtime: "durable" });
    expect((await routed.list("/work/a")).map((chat) => chat.id)).toEqual([legacyChat.id, durableChat.id]);
    expect((await routed.list("/work/a", { sessionId: durableChat.id })).map((chat) => chat.id)).toEqual([durableChat.id]);
    expect((await routed.listRecent(1)).map((chat) => chat.id)).toEqual([durableChat.id]);
    await expect(routed.locate(durableChat.id)).resolves.toEqual({ cwd: "/work/a" });
  });
});
