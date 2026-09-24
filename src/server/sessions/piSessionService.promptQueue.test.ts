import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInlineImageReferenceMapping, PiSessionService, stripInlineImageReferenceMapping } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, fakeRuntime, fakeSessionManager, runtimeCreator, seedCredential, sessionGateway, sessionRecord, sessionRef, TEST_MODEL_ID, TEST_MODEL_PROVIDER, testModel, testModelRuntime, type RuntimeCreator } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

describe("appendInlineImageReferenceMapping", () => {
  it("maps the exact surviving reference order to the following image blocks", () => {
    const displayText = "compare [PIC_3] and [PIC_1]";
    const providerText = appendInlineImageReferenceMapping(displayText, ["[PIC_1]", "[PIC_3]"]);
    expect(providerText).toBe(
      "compare [PIC_3] and [PIC_1]\n\nImage blocks immediately following this text map in order as follows:\n1. [PIC_1]\n2. [PIC_3]",
    );
    expect(stripInlineImageReferenceMapping(providerText)).toBe(displayText);
  });
});

beforeEach(() => {
  // Pi 0.82 uses PI_OFFLINE for refreshes after runtime creation. These tests
  // exercise local model/auth behavior and must never fetch provider catalogs.
  vi.stubEnv("PI_OFFLINE", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PiSessionService prompt, queue, and auth warnings", () => {
  it("sends prompts to an injected runtime without touching the SDK runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("prompt-session"), "Build the thing");

    expect(fake.calls.prompt).toEqual([{ text: "Build the thing", options: undefined }]);
    await service.dispose();
  });

  it("preserves slash prose byte-for-byte while sending image legends only to the provider", async () => {
    const fake = fakeRuntime("image-text-session");
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("image-text-session")]),
      heartbeatIntervalMs: 60_000,
    });
    const attachment = { kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    const displayTexts = [
      "/Users/thomas/project screenshot [PIC_1]",
      "  /not-a-command inspect [PIC_1]\n",
    ];

    for (const displayText of displayTexts) await service.prompt(sessionRef("image-text-session"), displayText, undefined, [attachment]);

    expect(fake.calls.prompt.map(({ text }) => text)).toEqual(displayTexts.map((text) => appendInlineImageReferenceMapping(text, ["[PIC_1]"])));
    const appendEvents = hub.sessionEvents.filter(({ event }) => event.type === "message.append").map(({ event }) => JSON.stringify(event));
    expect(appendEvents).toHaveLength(displayTexts.length);
    expect(appendEvents.every((event, index) => event.includes(JSON.stringify(displayTexts[index] ?? "").slice(1, -1)) && !event.includes("Image blocks immediately following"))).toBe(true);
    await service.dispose();
  });

  it("keeps two explicit references aligned with native image order", async () => {
    const fake = fakeRuntime("ordered-image-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("ordered-image-session")]),
      heartbeatIntervalMs: 60_000,
    });
    const redPixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const bluePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
    const attachments = [
      { kind: "image", reference: "[PIC_2]", mimeType: "image/png", data: bluePixel },
      { kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: redPixel },
    ];

    await service.prompt(sessionRef("ordered-image-session"), "compare [PIC_1] with [PIC_2]", undefined, attachments);

    expect(fake.calls.prompt[0]?.text).toBe(appendInlineImageReferenceMapping("compare [PIC_1] with [PIC_2]", ["[PIC_2]", "[PIC_1]"]));
    const options = fake.calls.prompt[0]?.options;
    const images: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "images") : undefined;
    expect(Array.isArray(images) ? images.map((image: unknown) => {
      const data: unknown = typeof image === "object" && image !== null ? Reflect.get(image, "data") : undefined;
      return data;
    }) : []).toEqual([bluePixel, redPixel]);
    await service.dispose();
  });

  it("keeps old-client image prompts unchanged for both display and provider text", async () => {
    const fake = fakeRuntime("old-client-image-session");
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("old-client-image-session")]),
      heartbeatIntervalMs: 60_000,
    });
    const legacyAttachment = { kind: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };

    await service.prompt(sessionRef("old-client-image-session"), "legacy image", undefined, [legacyAttachment]);

    expect(fake.calls.prompt[0]?.text).toBe("legacy image");
    const appendEvent = hub.sessionEvents.find(({ event }) => event.type === "message.append")?.event;
    expect(JSON.stringify(appendEvent)).toContain("legacy image");
    expect(JSON.stringify(appendEvent)).not.toContain("Image blocks immediately following");
    await service.dispose();
  });

  it("strips provider-only image legends from durable transcript history", async () => {
    const displayText = "inspect [PIC_1]";
    const providerText = appendInlineImageReferenceMapping(displayText, ["[PIC_1]"]);
    const fake = fakeRuntime("image-history-session", {
      sessionManager: fakeSessionManager("/workspace", {
        getBranch: () => [{ type: "message", id: "user-1", message: { role: "user", content: providerText } }],
      }),
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("image-history-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.messages(sessionRef("image-history-session"))).resolves.toMatchObject({
      messages: [{ role: "user", content: displayText }],
    });
    await service.dispose();
  });

  it("keeps queued display text clean while retaining provider mapping through promotion", async () => {
    const queued: string[] = [];
    const fake = fakeRuntime("queued-image-text-session", { isStreaming: true, getFollowUpMessages: () => queued });
    const prompt = fake.session.prompt.bind(fake.session);
    fake.session.prompt = (text, options) => {
      queued.push(text);
      return prompt(text, options);
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("queued-image-text-session")]),
      heartbeatIntervalMs: 60_000,
    });
    const attachment = { kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    const providerText = appendInlineImageReferenceMapping("inspect [PIC_1]", ["[PIC_1]"]);

    await service.prompt(sessionRef("queued-image-text-session"), "inspect [PIC_1]", "followUp", [attachment]);

    expect(fake.calls.prompt[0]?.text).toBe(providerText);
    await expect(service.status(sessionRef("queued-image-text-session"))).resolves.toMatchObject({
      queuedMessages: [{ kind: "followUp", text: "inspect [PIC_1]" }],
    });
    await service.dispose();
  });

  it("strips staged tokens from known commands before display and provider delivery", async () => {
    const fake = fakeRuntime("slash-image-session");
    fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "command" }];
    fake.session.promptTemplates = [{ name: "template-name" }];
    fake.session.resourceLoader.getSkills = () => ({ skills: [{ name: "skill-name" }] });
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("slash-image-session")]),
      heartbeatIntervalMs: 60_000,
    });
    const attachment = { kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
    const prompts = [
      ["/model inspect [PIC_1]", "/model inspect"],
      ["/command [PIC_1] --raw", "/command --raw"],
      ["/template-name exact [PIC_1] bytes", "/template-name exact bytes"],
      ["  /skill:skill-name [PIC_1] exact bytes\n\n", "/skill:skill-name exact bytes"],
    ];

    for (const [input] of prompts) await service.prompt(sessionRef("slash-image-session"), input, undefined, [attachment]);

    const cleaned = prompts.map(([, expected]) => expected);
    expect(fake.calls.prompt.map(({ text }) => text)).toEqual(cleaned);
    const displayed = hub.sessionEvents.filter(({ event }) => event.type === "message.append").map(({ event }) => JSON.stringify(event));
    expect(displayed).toHaveLength(cleaned.length);
    expect(displayed.every((event, index) => event.includes(cleaned[index] ?? "") && !event.includes("[PIC_1]"))).toBe(true);
    expect(fake.calls.prompt.every(({ options }) => {
      if (typeof options !== "object" || options === null) return false;
      const images: unknown = Reflect.get(options, "images");
      return Array.isArray(images) && images.length === 1;
    })).toBe(true);

    const legacyAttachment = { kind: "image", mimeType: "image/png", data: attachment.data };
    await service.prompt(sessionRef("slash-image-session"), "  /command literal [PIC_1]\n", undefined, [legacyAttachment]);
    expect(fake.calls.prompt.at(-1)?.text).toBe("/command literal [PIC_1]");
    expect(fake.calls.prompt.at(-1)?.text).not.toContain("Image blocks immediately following");
    await service.dispose();
  });

  it("echoes the user message for direct prompts but not command-forwarded ones", async () => {
    const fake = fakeRuntime("echo-session", {
      resourceLoader: { getSkills: () => ({ skills: [{ name: "skill-creator" }] }) },
    });
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("echo-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("echo-session"), "Build the thing");
    expect(hub.sessionEvents.filter(({ event }) => event.type === "message.append")).toHaveLength(1);

    // The client optimistically renders command-forwarded prompts (e.g. /skill:*),
    // so the server must not publish a second copy via message.append.
    await service.runCommand(sessionRef("echo-session"), "/skill:skill-creator");
    expect(hub.sessionEvents.filter(({ event }) => event.type === "message.append")).toHaveLength(1);
    expect(fake.calls.prompt).toEqual([
      { text: "Build the thing", options: undefined },
      { text: "/skill:skill-creator", options: undefined },
    ]);

    await service.dispose();
  });

  it("rejects malformed prompt text before opening the runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = async () => {
      createCalls += 1;
      await Promise.resolve();
      return fake.runtime;
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.prompt(sessionRef("prompt-session"), undefined)).rejects.toThrow("Prompt text is required");

    expect(createCalls).toBe(0);
    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("generates a session name for the first prompt via the session's agent.streamFunction", async () => {
    const model = testModel();
    const streamCalls: unknown[] = [];
    const streamFn: StreamFn = (streamModel, context, options) => {
      streamCalls.push({ streamModel, context, options });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Fix login bug" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("name-session", { model, agent: { streamFunction: streamFn } });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("name-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(fake.session.sessionName).toBe("Fix login bug"); });

    expect(streamCalls).toHaveLength(1);
    expect(hub.sessionEvents.some(({ event }) => event.type === "session.name" && event.name === "Fix login bug")).toBe(true);
    await service.dispose();
  });

  it("includes queued message details in session status", async () => {
    const fake = fakeRuntime("status-session", {
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
      pendingMessageCount: 2,
      getSteeringMessages: () => ["adjust this turn"],
      getFollowUpMessages: () => ["then do this"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("status-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.status(sessionRef("status-session"))).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this turn" }, { kind: "followUp", text: "then do this" }],
      messageCount: 2,
    });
    await service.dispose();
  });

  it("does not enqueue duplicate queued message text", async () => {
    const fake = fakeRuntime("dedupe-session", {
      isStreaming: true,
      pendingMessageCount: 1,
      getFollowUpMessages: () => ["already queued"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("dedupe-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("dedupe-session"), "already queued", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("does not append queued prompts to the transcript before delivery", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("queued-session", { isStreaming: true });
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("queued-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("queued-session"), "Wait for the current turn", "followUp");

    expect(fake.calls.prompt).toEqual([{ text: "Wait for the current turn", options: { streamingBehavior: "followUp" } }]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await service.dispose();
  });

  it("holds prompts sent during compaction until compaction finishes", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("compacting-session", { isCompacting: true });
    let resolveFirstPrompt: (() => void) | undefined;
    fake.session.prompt = (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
      fake.calls.prompt.push({ text, options });
      if (options === undefined) {
        fake.session.isStreaming = true;
        return new Promise<void>((resolve) => { resolveFirstPrompt = resolve; });
      }
      return Promise.resolve();
    };
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("compacting-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("compacting-session"), "Start task 1", "followUp");
    await service.prompt(sessionRef("compacting-session"), "Then task 2", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "followUp", text: "Start task 1" }, { kind: "followUp", text: "Then task 2" }],
    });

    fake.session.isCompacting = false;
    fake.emit({ type: "compaction_end" });
    // compaction_end drains the held queue on a scheduled timer; wait for the
    // first prompt to be delivered rather than sleeping a fixed interval.
    await vi.waitFor(() => {
      expect(fake.calls.prompt).toEqual([{ text: "Start task 1", options: undefined }]);
    });

    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append" && JSON.stringify(event.message).includes("Start task 1"))).toBe(true);
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 1,
      queuedMessages: [{ kind: "followUp", text: "Then task 2" }],
    });

    fake.emit({ type: "agent_start" });
    // agent_start drains the next queued prompt asynchronously; wait for both
    // prompts to have been delivered rather than sleeping.
    await vi.waitFor(() => {
      expect(fake.calls.prompt).toEqual([
        { text: "Start task 1", options: undefined },
        { text: "Then task 2", options: { streamingBehavior: "followUp" } },
      ]);
    });
    await expect(service.status(sessionRef("compacting-session"))).resolves.toMatchObject({
      pendingMessageCount: 0,
      queuedMessages: [],
    });
    resolveFirstPrompt?.();
    await service.dispose();
  });

  it("promotes a browser-queued image without exposing a partial rebuilt queue", async () => {
    const steeringMessages: string[] = [];
    const followUpMessages: string[] = [];
    const operations: string[] = [];
    const releases: (() => void)[] = [];
    const requeuedImages: unknown[] = [];
    const fake = fakeRuntime("promote-one-session", {
      isStreaming: true,
      getSteeringMessages: () => steeringMessages,
      getFollowUpMessages: () => followUpMessages,
    });
    fake.session.prompt = (text, options) => {
      fake.calls.prompt.push({ text, options });
      (options?.streamingBehavior === "steer" ? steeringMessages : followUpMessages).push(text);
      return Promise.resolve();
    };
    fake.session.clearQueue = () => {
      operations.push("clear");
      const cleared = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      return cleared;
    };
    fake.session.steer = (text, images) => {
      operations.push(`steer:${text}`);
      steeringMessages.push(text);
      requeuedImages.push(images);
      return new Promise<void>((resolve) => { releases.push(resolve); });
    };
    fake.session.followUp = (text, images) => {
      operations.push(`followUp:${text}`);
      followUpMessages.push(text);
      requeuedImages.push(images);
      return new Promise<void>((resolve) => { releases.push(resolve); });
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("promote-one-session")]),
      heartbeatIntervalMs: 60_000,
    });
    const imageAttachment = { kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", name: "pixel.png" };
    const promotedText = appendInlineImageReferenceMapping("promote me", [imageAttachment.reference]);
    await service.prompt(sessionRef("promote-one-session"), "existing steer", "steer");
    await service.prompt(sessionRef("promote-one-session"), "promote me", "followUp", [imageAttachment]);
    await service.prompt(sessionRef("promote-one-session"), "keep later", "followUp");
    const originalOptions = fake.calls.prompt[1]?.options;
    if (typeof originalOptions !== "object" || originalOptions === null) throw new Error("queued image options missing");
    const originalImages: unknown = Reflect.get(originalOptions, "images");

    const promotion = service.promoteQueuedMessage(sessionRef("promote-one-session"), { kind: "followUp", text: "promote me" });
    await vi.waitFor(() => { expect(operations).toHaveLength(4); });

    expect(operations).toEqual(["clear", "steer:existing steer", `steer:${promotedText}`, "followUp:keep later"]);
    expect(steeringMessages).toEqual(["existing steer", promotedText]);
    expect(followUpMessages).toEqual(["keep later"]);
    expect(requeuedImages[1]).toEqual(originalImages);
    releases.forEach((release) => { release(); });
    await expect(promotion).resolves.toMatchObject({
      queuedMessages: [
        { kind: "steer", text: "existing steer" },
        { kind: "steer", text: "promote me" },
        { kind: "followUp", text: "keep later" },
      ],
    });
    await service.dispose();
  });

  it("keeps repeated one-at-a-time promotions in click order", async () => {
    const steeringMessages: string[] = [];
    const followUpMessages: string[] = [];
    const fake = fakeRuntime("promote-in-order-session", {
      isStreaming: true,
      getSteeringMessages: () => steeringMessages,
      getFollowUpMessages: () => followUpMessages,
    });
    fake.session.prompt = (text, options) => {
      (options?.streamingBehavior === "steer" ? steeringMessages : followUpMessages).push(text);
      return Promise.resolve();
    };
    fake.session.clearQueue = () => {
      const cleared = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      return cleared;
    };
    fake.session.steer = (text, images) => {
      fake.calls.steer.push({ text, images });
      steeringMessages.push(text);
      return Promise.resolve();
    };
    fake.session.followUp = (text, images) => {
      fake.calls.followUp.push({ text, images });
      followUpMessages.push(text);
      return Promise.resolve();
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("promote-in-order-session")]),
      heartbeatIntervalMs: 60_000,
    });
    await service.prompt(sessionRef("promote-in-order-session"), "first", "followUp");
    await service.prompt(sessionRef("promote-in-order-session"), "second", "followUp");
    await service.prompt(sessionRef("promote-in-order-session"), "later", "followUp");

    await service.promoteQueuedMessage(sessionRef("promote-in-order-session"), { kind: "followUp", text: "first" });
    const status = await service.promoteQueuedMessage(sessionRef("promote-in-order-session"), { kind: "followUp", text: "second" });

    expect(status.queuedMessages).toEqual([
      { kind: "steer", text: "first" },
      { kind: "steer", text: "second" },
      { kind: "followUp", text: "later" },
    ]);
    await service.dispose();
  });

  it("promotes ordinary browser-queued text with the public steering API", async () => {
    const steeringMessages: string[] = [];
    const followUpMessages: string[] = [];
    const fake = fakeRuntime("promote-all-session", {
      isStreaming: true,
      getSteeringMessages: () => steeringMessages,
      getFollowUpMessages: () => followUpMessages,
    });
    fake.session.prompt = (text, options) => {
      (options?.streamingBehavior === "steer" ? steeringMessages : followUpMessages).push(text);
      return Promise.resolve();
    };
    fake.session.clearQueue = () => {
      const cleared = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      return cleared;
    };
    fake.session.steer = (text, images) => {
      fake.calls.steer.push({ text, images });
      steeringMessages.push(text);
      return Promise.resolve();
    };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("promote-all-session")]),
      heartbeatIntervalMs: 60_000,
    });
    await service.prompt(sessionRef("promote-all-session"), "steer one", "steer");
    await service.prompt(sessionRef("promote-all-session"), "follow one", "followUp");
    await service.prompt(sessionRef("promote-all-session"), "follow two", "followUp");

    const status = await service.promoteAllQueuedMessages(sessionRef("promote-all-session"));

    expect(fake.calls.steer.map(({ text }) => text)).toEqual(["steer one", "follow one", "follow two"]);
    expect(status.queuedMessages).toEqual([
      { kind: "steer", text: "steer one" },
      { kind: "steer", text: "follow one" },
      { kind: "steer", text: "follow two" },
    ]);
    await service.dispose();
  });

  it("rejects unknown runtime queue provenance before clearing anything", async () => {
    const fake = fakeRuntime("unknown-promotion-session", {
      isStreaming: true,
      getSteeringMessages: () => ["outside PI WEB"],
      getFollowUpMessages: () => ["keep me"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("unknown-promotion-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.promoteAllQueuedMessages(sessionRef("unknown-promotion-session"))).rejects.toThrow("promotion was not applied");

    expect(fake.calls.clearQueue).toBe(0);
    expect(fake.calls.steer).toEqual([]);
    expect(fake.calls.followUp).toEqual([]);
    await service.dispose();
  });

  it("clears runtime and compaction queues without interrupting active work", async () => {
    const steeringMessages = ["adjust this turn"];
    const followUpMessages = ["then do this"];
    const transcript = [{ role: "user", content: "keep this history" }];
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("clear-queue-session", {
      messages: transcript,
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 2,
      getSteeringMessages: () => steeringMessages,
      getFollowUpMessages: () => followUpMessages,
    });
    const clearRuntimeQueue = vi.fn(() => {
      const cleared = { steering: [...steeringMessages], followUp: [...followUpMessages] };
      steeringMessages.length = 0;
      followUpMessages.length = 0;
      fake.session.pendingMessageCount = 0;
      return cleared;
    });
    fake.session.clearQueue = clearRuntimeQueue;
    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("clear-queue-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("clear-queue-session"), "queued during compaction", "followUp");
    await expect(service.status(sessionRef("clear-queue-session"))).resolves.toMatchObject({
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 3,
      queuedMessages: [
        { kind: "steer", text: "adjust this turn" },
        { kind: "followUp", text: "then do this" },
        { kind: "followUp", text: "queued during compaction" },
      ],
    });

    const status = await service.clearQueue(sessionRef("clear-queue-session"));

    expect(clearRuntimeQueue).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      isStreaming: true,
      isCompacting: true,
      pendingMessageCount: 0,
      queuedMessages: [],
      messageCount: 1,
    });
    expect(fake.session.messages).toBe(transcript);
    expect(fake.calls.prompt).toEqual([]);
    expect(fake.calls.abort).toBe(0);
    expect(fake.calls.dispose).toBe(0);
    const publishedStatuses = hub.sessionEvents.filter(({ event }) => event.type === "status.update");
    expect(publishedStatuses.at(-1)?.event).toEqual({ type: "status.update", status });
    await service.dispose();
  });

  it("clears an already-empty queue idempotently", async () => {
    const fake = fakeRuntime("clear-empty-queue-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("clear-empty-queue-session")]),
      heartbeatIntervalMs: 60_000,
    });

    const firstStatus = await service.clearQueue(sessionRef("clear-empty-queue-session"));
    const secondStatus = await service.clearQueue(sessionRef("clear-empty-queue-session"));

    expect(fake.calls.clearQueue).toBe(2);
    expect(fake.calls.abort).toBe(0);
    expect(firstStatus).toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    expect(secondStatus).toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    await service.dispose();
  });

  it("clears queued messages when aborting active work", async () => {
    const fake = fakeRuntime("abort-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("abort-session"));
    await service.abort(sessionRef("abort-session"));

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.abort).toBe(1);
    await service.dispose();
  });

  it("clears prompts queued during compaction when aborting active work", async () => {
    const fake = fakeRuntime("abort-compaction-session", { isCompacting: true });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-compaction-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt(sessionRef("abort-compaction-session"), "Do not deliver after abort", "followUp");
    await expect(service.status(sessionRef("abort-compaction-session"))).resolves.toMatchObject({ pendingMessageCount: 1 });
    await service.abort(sessionRef("abort-compaction-session"));

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.prompt).toEqual([]);
    await expect(service.status(sessionRef("abort-compaction-session"))).resolves.toMatchObject({ pendingMessageCount: 0, queuedMessages: [] });
    await service.dispose();
  });

  it("reloads models.json before listing and selecting models", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-web-model-runtime-"));
    try {
      const modelsPath = join(agentDir, "models.json");
      await writeLocalModelsConfig(modelsPath, "initial-model");
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath,
        allowModelNetwork: false,
      });
      const setSessionModel = vi.fn(() => Promise.resolve());
      const fake = fakeRuntime("models-session", { modelRuntime, setModel: setSessionModel });
      const service = new PiSessionService(new CapturingSessionEventHub(), {
        agentDir,
        modelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("models-session")]),
        heartbeatIntervalMs: 60_000,
      });

      try {
        await writeLocalModelsConfig(modelsPath, "listed-model");
        const listed = await service.availableModels(sessionRef("models-session"));
        expect(listed).toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "test-local", id: "listed-model" }),
        ]));
        expect(listed).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ provider: "test-local", id: "initial-model" }),
        ]));

        await writeLocalModelsConfig(modelsPath, "selected-model");
        await expect(service.setModel(sessionRef("models-session"), "test-local", "selected-model")).resolves.toBeDefined();
        expect(setSessionModel).toHaveBeenCalledWith(expect.objectContaining({
          provider: "test-local",
          id: "selected-model",
        }));
      } finally {
        await service.dispose();
      }
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes auth state and dedupes warnings when logout removes the current model's credentials", async () => {
    const hub = new CapturingSessionEventHub();
    // The shared model runtime reads a live credential store. Mutating the store
    // and refreshing here simulates the committed snapshot that
    // ModelRuntime.login()/logout() establishes before AuthService emits.
    // applyAuthChange then only needs to notify active sessions.
    const credentials = new InMemoryCredentialStore();
    await seedCredential(credentials, "anthropic", { type: "api_key", key: "sk-test" });
    const modelRuntime = await createTestModelRuntime(credentials);
    const model = modelRuntime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
    if (model === undefined) throw new Error("Expected Anthropic model fixture");
    const fake = fakeRuntime("auth-session", { model, modelRuntime });

    const service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("auth-session"));
    hub.sessionEvents.length = 0;
    hub.globalEvents.length = 0;

    await credentials.delete("anthropic");
    await modelRuntime.refresh();
    service.applyAuthChange({ removedProviderId: "anthropic" });
    service.applyAuthChange({ removedProviderId: "anthropic" });

    const warningCount = () => hub.sessionEvents.filter(({ event }) => event.type === "command.output" && event.level === "error" && event.message.includes(`${TEST_MODEL_PROVIDER}/${TEST_MODEL_ID}`)).length;
    expect(warningCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "auth-session")).toBe(true);

    await seedCredential(credentials, "anthropic", { type: "api_key", key: "sk-new" });
    await modelRuntime.refresh();
    service.applyAuthChange();
    await credentials.delete("anthropic");
    await modelRuntime.refresh();
    service.applyAuthChange({ removedProviderId: "anthropic" });
    expect(warningCount()).toBe(2);

    await service.dispose();
  });

  it("clears queued messages when stopping a session runtime", async () => {
    const fake = fakeRuntime("stop-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("stop-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status(sessionRef("stop-session"));
    await service.stop(sessionRef("stop-session"));

    expect(fake.calls.clearQueue).toBe(1);
    await service.dispose();
  });
});

async function writeLocalModelsConfig(path: string, modelId: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    providers: {
      "test-local": {
        name: "Test Local",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "offline-test-key",
        api: "openai-completions",
        models: [{
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000,
          maxTokens: 100,
        }],
      },
    },
  }));
}
