import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FEDERATED_HTTP_ROUTES } from "../../shared/federatedRoutes.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";
import { TOPIC_ACK_TYPE, TOPIC_INPUT_TYPE, TOPIC_OPEN_TYPE, TOPIC_POST_TYPE, topicImages, topicSnapshot, topicSnapshots, topicSummaries, topicText, topicTitle } from "./sessionTopic.js";

const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const image = (data = tinyPng) => ({ kind: "image", reference: "[PIC_1]", mimeType: "image/png", data });

const timestamp = "2026-01-01T00:00:00.000Z";
const open = { type: "custom", customType: TOPIC_OPEN_TYPE, id: "open", timestamp, data: { topicId: "files", title: "Files" } };
const input = (id: string, topicId: string, text: string) => ({ type: "custom_message", customType: TOPIC_INPUT_TYPE, id, timestamp, details: { topicId, text } });
const post = (id: string, topicId: string, text: string, attention?: string) => ({ type: "custom", customType: TOPIC_POST_TYPE, id, timestamp, data: { topicId, text, attention, choices: [{ label: "Yes", detail: "Proceed" }] } });

describe("session topics", () => {
  it("federates the full topic API", () => {
    for (const [method, path] of [["GET", "/sessions/:sessionId/topics"], ["POST", "/sessions/:sessionId/topics"], ["GET", "/sessions/:sessionId/topics/:topicId"], ["POST", "/sessions/:sessionId/topics/:topicId/messages"], ["POST", "/sessions/:sessionId/topics/:topicId/ack"]]) {
      expect(FEDERATED_HTTP_ROUTES).toContainEqual(expect.objectContaining({ method, path }));
    }
  });

  it("isolates branch-scoped topics and synthesizes legacy Focus", () => {
    const entries = [input("legacy", "focus", "old"), open, input("u", "files", "Question"), post("p", "files", "Choose", "question"), post("q", "files", "News", "update")];
    expect(topicSnapshots(entries, false)).toMatchObject([{ topicId: "focus", title: "Focus", messages: [{ text: "old" }] }, { topicId: "files", title: "Files", attention: "update", messages: [{ role: "user" }, { attention: "question", choices: [{ label: "Yes" }] }, { attention: "update" }] }]);
    expect(topicSnapshot([...entries, { type: "custom", customType: TOPIC_ACK_TYPE, data: { topicId: "files", messageId: "q" } }], false, "files").attention).toBe("clear");
    expect(topicSnapshot(entries.slice(0, 3), false, "files")).toMatchObject({ state: "unanswered", attention: "unanswered" });
    expect(topicSnapshot(entries.slice(0, 4), false, "files").state).toBe("idle");
    expect(topicSummaries([{ ...open, data: { ...open.data, summary: "Waiting for layout answer" } }], false)).toMatchObject([{ topicId: "files", preview: "Waiting for layout answer" }]);
    expect(() => topicSnapshot(entries, false, "missing")).toThrow("Topic not found");
    expect(() => topicTitle("\nunsafe")).toThrow();
    expect(() => topicText(" ")).toThrow();
  });

  it("validates topic images, count and original byte limits", () => {
    expect(topicImages([image()])).toMatchObject([image()]);
    expect(() => topicImages([{ ...image(), mimeType: "image/svg+xml" }])).toThrow("unsupported image type");
    expect(() => topicImages([{ kind: "image", mimeType: "image/png", data: tinyPng }])).toThrow("reference");
    expect(() => topicImages([image("!!!!")])).toThrow("invalid base64");
    expect(() => topicImages([image("A")])).toThrow("invalid base64");
    expect(() => topicImages(Array.from({ length: 5 }, (_, index) => ({ ...image(), reference: `[PIC_${String(index + 1)}]` })))).toThrow("too many attachments");
    expect(() => topicImages([image("AAAA".repeat(2_796_203))])).toThrow("8 MiB");
    expect(() => topicImages([{ kind: "file", mimeType: "image/png", data: "AQID" }])).toThrow("unsupported kind");
    expect(() => topicText("", false)).toThrow();
    expect(topicText("", true)).toBe("");
    expect(() => topicText("x".repeat(16_385), true)).toThrow();
  });

  it("survives native JSONL reopen and selected-branch navigation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-topics-"));
    try {
      const manager = SessionManager.create("/workspace", dir);
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "lead" }], timestamp: Date.now(), api: "messages", provider: "anthropic", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
      manager.appendCustomEntry(TOPIC_OPEN_TYPE, { topicId: "files", title: "Files" });
      const fork = manager.appendCustomMessageEntry(TOPIC_INPUT_TYPE, [{ type: "text", text: "[Topic: files | Files] hidden" }, { type: "image", mimeType: "image/png", data: "AQID" }], false, { topicId: "files", text: "hello", requestId: "native-1", imageDigest: "digest" });
      manager.appendCustomEntry(TOPIC_POST_TYPE, { topicId: "files", text: "news", attention: "update" });
      const path = manager.getSessionFile();
      if (path === undefined) throw new Error("Session not saved");
      const reopened = SessionManager.open(path);
      expect(topicSnapshot(reopened.getBranch(), false, "files").attention).toBe("update");
      expect(reopened.getBranch().find((entry) => entry.id === fork)).toMatchObject({ details: { requestId: "native-1", imageDigest: "digest" }, content: [{ type: "text" }, { type: "image", data: "AQID" }] });
      reopened.branch(fork);
      expect(topicSnapshot(reopened.getBranch(), false, "files")).toMatchObject({ state: "unanswered", attention: "unanswered", messages: [{ text: "hello", requestId: "native-1", images: [{ mimeType: "image/png", data: "AQID" }] }] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("accepts input only after a distinct persisted entry, and rejects busy/unknown topics", async () => {
    const entries: unknown[] = [{ type: "message", id: "lead", message: { role: "assistant" } }, open];
    const fake = fakeRuntime("session-1");
    fake.session.sessionManager = fakeSessionManager("/workspace", { getBranch: () => entries });
    fake.session.sendCustomMessage = (message, options) => {
      fake.calls.sendCustomMessage.push({ message, options });
      fake.emit({ type: "message_end", message: { role: "custom", ...message } });
      entries.push({ type: "custom_message", id: `input-${String(entries.length)}`, timestamp, ...message });
      return Promise.resolve();
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000 });
    try {
      expect(await service.postTopicMessage(sessionRef("session-1"), "files", "hello", "req-1")).toEqual({ topicId: "files", status: "accepted" });
      expect(fake.calls.sendCustomMessage[0]).toMatchObject({ message: { display: false, details: { topicId: "files", text: "hello", requestId: "req-1" } }, options: { triggerTurn: true } });
      expect(fake.calls.sendCustomMessage[0]?.message.content).toContain("[Topic: files | Files]");
      await expect(service.postTopicMessage(sessionRef("session-1"), "missing", "hello", "req-missing")).rejects.toThrow("Topic not found");
      fake.emit({ type: "agent_start" });
      fake.emit({ type: "agent_end" });
      await expect(service.postTopicMessage(sessionRef("session-1"), "files", "busy", "req-busy")).rejects.toThrow("busy");
      fake.emit({ type: "agent_settled" });
      expect(fake.calls.prompt).toEqual([]);
    } finally { await service.dispose(); }
  });

  it("queues streaming replies once, then accepts only recorded branch input", async () => {
    const entries: unknown[] = [{ type: "message", id: "lead", message: { role: "assistant" } }, open];
    const fake = fakeRuntime("session-1", { isStreaming: true });
    fake.session.sessionManager = fakeSessionManager("/workspace", { getBranch: () => entries });
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000 });
    try {
      const ref = sessionRef("session-1");
      fake.emit({ type: "agent_start" }); // Real streaming runs stay unsettled until agent_settled.
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-1")).toEqual({ topicId: "files", status: "queued" });
      expect(fake.calls.sendCustomMessage).toMatchObject([{ message: { details: { topicId: "files", text: "hello", requestId: "retry-1" } }, options: { triggerTurn: true, deliverAs: "followUp" } }]);
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-1")).toMatchObject({ status: "queued" });
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
      await expect(service.postTopicMessage(ref, "files", "different", "retry-1")).rejects.toThrow("different content");
      entries.push({ ...input("delivered", "files", "hello"), details: { topicId: "files", text: "hello", requestId: "retry-1" } });
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-1")).toMatchObject({ status: "accepted" });
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
      fake.session.isStreaming = false;
      fake.emit({ type: "agent_settled" });
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-1")).toMatchObject({ status: "accepted" });
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
    } finally { await service.dispose(); }
  });

  it("queues image-only content and compares original images on retry", async () => {
    const entries: unknown[] = [{ type: "message", id: "lead", message: { role: "assistant" } }, open];
    const fake = fakeRuntime("session-1", { isStreaming: true });
    fake.session.sessionManager = fakeSessionManager("/workspace", { getBranch: () => entries });
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000 });
    try {
      const ref = sessionRef("session-1");
      expect(await service.postTopicMessage(ref, "files", "", "image-1", [image()])).toMatchObject({ status: "queued" });
      const sent = fake.calls.sendCustomMessage[0]?.message;
      expect(sent).toMatchObject({ content: [{ type: "text" }, { type: "image", mimeType: "image/png" }], details: { text: "", requestId: "image-1" } });
      expect(typeof sent?.details === "object" && sent.details !== null && "imageDigest" in sent.details && typeof sent.details.imageDigest).toBe("string");
      expect(Array.isArray(sent?.content) && sent.content[0]?.type === "text" && sent.content[0].text).toContain("[Topic: files | Files]");
      expect(JSON.stringify(sent?.details)).not.toContain(tinyPng);
      expect(await service.postTopicMessage(ref, "files", "", "image-1", [{ ...image(), reference: "[PIC_2]", name: "reattached.png" }])).toMatchObject({ status: "queued" });
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
      await expect(service.postTopicMessage(ref, "files", "", "image-1", [image("BAUG")])).rejects.toThrow("different content");
      entries.push({ type: "custom_message", customType: TOPIC_INPUT_TYPE, id: "delivered", timestamp, ...sent });
      expect(await service.postTopicMessage(ref, "files", "", "image-1", [image()])).toMatchObject({ status: "accepted" });
      expect(topicSnapshot(entries, false, "files").messages[0]?.images).toMatchObject([{ mimeType: "image/png" }]);
      expect(topicSummaries(entries, false)[0]?.preview).toBe("1 image");
    } finally { await service.dispose(); }
  });

  it("does not claim queued or enqueue twice during concurrent image conversion", async () => {
    const entries: unknown[] = [{ type: "message", id: "lead", message: { role: "assistant" } }, open];
    const fake = fakeRuntime("session-1", { isStreaming: true });
    fake.session.sessionManager = fakeSessionManager("/workspace", { getBranch: () => entries });
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000 });
    try {
      const ref = sessionRef("session-1");
      const results = await Promise.all([service.postTopicMessage(ref, "files", "", "concurrent", [image()]), service.postTopicMessage(ref, "files", "", "concurrent", [image()])]);
      expect(results).toEqual([{ topicId: "files", status: "queued" }, { topicId: "files", status: "queued" }]);
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
    } finally { await service.dispose(); }
  });

  it("retries an undelivered queued input after a cleared run settles, but refuses compaction and unsettled runs", async () => {
    const entries: unknown[] = [{ type: "message", id: "lead", message: { role: "assistant" } }, open];
    const fake = fakeRuntime("session-1", { isStreaming: true });
    fake.session.sessionManager = fakeSessionManager("/workspace", { getBranch: () => entries });
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000 });
    try {
      const ref = sessionRef("session-1");
      await expect(service.postTopicMessage(ref, "files", "hello", " ")).rejects.toThrow("Invalid topic request id");
      await expect(service.postTopicMessage(ref, "files", "hello", "x".repeat(129))).rejects.toThrow("Invalid topic request id");
      fake.session.isCompacting = true;
      await expect(service.postTopicMessage(ref, "files", "hello", "retry-2")).rejects.toThrow("busy");
      fake.session.isCompacting = false;
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-2")).toMatchObject({ status: "queued" });
      await service.clearQueue(ref);
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-2")).toMatchObject({ status: "queued" });
      expect(fake.calls.sendCustomMessage).toHaveLength(1);
      fake.session.isStreaming = false;
      fake.emit({ type: "agent_start" });
      fake.emit({ type: "agent_end" });
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-2")).toMatchObject({ status: "queued" });
      await expect(service.postTopicMessage(ref, "files", "new", "retry-3")).rejects.toThrow("busy");
      fake.emit({ type: "agent_settled" });
      await Promise.resolve();
      fake.session.sendCustomMessage = (message, options) => {
        fake.calls.sendCustomMessage.push({ message, options });
        entries.push({ type: "custom_message", id: "retry-delivered", timestamp, ...message });
        fake.emit({ type: "message_end", message: { role: "custom", ...message } });
        return Promise.resolve();
      };
      expect(await service.postTopicMessage(ref, "files", "hello", "retry-2")).toMatchObject({ status: "accepted" });
      expect(fake.calls.sendCustomMessage).toHaveLength(2);
    } finally { await service.dispose(); }
  });

  it("persists owner-created topics and acknowledges only the current update", async () => {
    const entries: unknown[] = [{ type: "message", id: "lead", message: { role: "assistant" } }];
    const fake = fakeRuntime("session-1");
    fake.session.sessionManager = fakeSessionManager("/workspace", {
      getSessionFile: () => "/sessions/session-1.jsonl",
      getBranch: () => entries,
      appendCustomEntry: (customType, data) => {
        const id = `entry-${String(entries.length)}`;
        entries.push({ type: "custom", customType, id, timestamp, data });
        return id;
      },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000 });
    try {
      const assistant = entries.shift();
      await expect(service.createTopic(sessionRef("session-1"), "Too early")).rejects.toThrow("persisted assistant turn");
      if (assistant !== undefined) entries.unshift(assistant);
      const topic = await service.createTopic(sessionRef("session-1"), "Files");
      expect(topic).toMatchObject({ title: "Files", attention: "clear" });
      expect((await service.topics(sessionRef("session-1"))).topics).toContainEqual(topic);
      await expect(service.acknowledgeTopic(sessionRef("session-1"), topic.topicId)).rejects.toThrow("No update");
      fake.session.sessionManager.appendCustomEntry?.(TOPIC_POST_TYPE, { topicId: topic.topicId, text: "Ready", attention: "update" });
      expect((await service.acknowledgeTopic(sessionRef("session-1"), topic.topicId)).attention).toBe("clear");
      expect(entries.at(-1)).toMatchObject({ customType: TOPIC_ACK_TYPE });
      await expect(service.acknowledgeTopic(sessionRef("session-1"), topic.topicId)).rejects.toThrow("No update");
    } finally { await service.dispose(); }
  });

  it("rejects a settled turn that never persisted the input", async () => {
    const fake = fakeRuntime("session-1");
    fake.session.sessionManager = fakeSessionManager("/workspace", { getBranch: () => [{ type: "message", id: "lead", message: { role: "assistant" } }, open] });
    fake.session.sendCustomMessage = vi.fn(() => Promise.resolve());
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([sessionRecord("session-1")]), archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000 });
    try { await expect(service.postTopicMessage(sessionRef("session-1"), "files", "hello", "req-1")).rejects.toThrow("not persisted"); }
    finally { await service.dispose(); }
  });
});
