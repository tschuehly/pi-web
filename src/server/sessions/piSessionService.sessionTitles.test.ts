import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSessionService, sessionNameSource } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModel, testModelRuntime } from "./piSessionService.testSupport.js";

const SESSION_ID = "title-session";
let sessionDir: string;

beforeEach(async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  sessionDir = await mkdtemp(join(tmpdir(), "pi-web-session-titles-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sessionDir, { recursive: true, force: true });
});

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** A Pi-backed fake: names and messages live in a real SessionManager, like the SDK session. */
function titledSession(manager: SessionManager, titles: string[]) {
  const titleRequests: string[] = [];
  const streamFn: StreamFn = (_model, context) => {
    const request = context.messages.at(-1);
    titleRequests.push(typeof request?.content === "string" ? request.content : "");
    const message = assistant(titles.shift() ?? "");
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  const fake = fakeRuntime(SESSION_ID, { model: testModel(), agent: { streamFunction: streamFn }, sessionManager: manager });
  Object.defineProperty(fake.session, "sessionName", { get: () => manager.getSessionName(), configurable: true });
  fake.session.setSessionName = (name: string) => { manager.appendSessionInfo(name); };
  fake.session.prompt = (text: string) => {
    fake.calls.prompt.push({ text, options: undefined });
    // Pi expands /skill:<name> [args] into a skill block before persisting the user message.
    const skill = /^\/skill:(\S+)\s*([\s\S]*)$/.exec(text);
    const content = skill === null ? text : `<skill name="${skill[1] ?? ""}" location="/skills/${skill[1] ?? ""}/SKILL.md">\nSkill body.\n</skill>${skill[2] === "" ? "" : `\n\n${skill[2] ?? ""}`}`;
    manager.appendMessage({ role: "user", content, timestamp: Date.now() });
    manager.appendMessage(assistant(`answer to ${text}`));
    return Promise.resolve();
  };
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
    heartbeatIntervalMs: 60_000,
  });
  const send = async (text: string) => {
    const before = fake.calls.prompt.length;
    await service.prompt(sessionRef(SESSION_ID), text);
    await vi.waitFor(() => { expect(fake.calls.prompt.length).toBe(before + 1); });
  };
  return { service, send, titleRequests, manager };
}

describe("PiSessionService session titles", () => {
  it("does not name a session from a skill-only first prompt and names it from the next real prompt", async () => {
    const { service, send, titleRequests, manager } = titledSession(SessionManager.inMemory("/workspace"), ["Login redirect fix"]);

    await send("/skill:orient brief");
    await send("<skill name=\"tdd\" location=\"/skills/tdd/SKILL.md\">\nbody\n</skill>");
    expect(manager.getSessionName()).toBeUndefined();
    expect(titleRequests).toEqual([]);

    await send("Fix the login redirect loop");
    await vi.waitFor(() => { expect(manager.getSessionName()).toBe("Login redirect fix"); });
    expect(titleRequests).toEqual([expect.stringContaining("Fix the login redirect loop")]);
    expect(sessionNameSource(manager.getEntries())).toBe("auto");
    await service.dispose();
  });

  it("regenerates an automatic title once from the session goal at the fifth owner prompt", async () => {
    const { service, send, titleRequests, manager } = titledSession(SessionManager.inMemory("/workspace"), ["Login fix", "Auth session hardening"]);

    await send("Fix the login redirect loop");
    await vi.waitFor(() => { expect(manager.getSessionName()).toBe("Login fix"); });
    for (const text of ["Also check cookie expiry", "/skill:tdd", "Add refresh token rotation"]) await send(text);
    expect(titleRequests).toHaveLength(1);

    await send("Now document the auth flow");
    await vi.waitFor(() => { expect(manager.getSessionName()).toBe("Auth session hardening"); });
    const goalRequest = titleRequests[1] ?? "";
    expect(goalRequest).toContain("goal of this chat session");
    expect(goalRequest).toContain("Prompt 4:\nNow document the auth flow");
    expect(goalRequest).toContain("First answer:\nanswer to Fix the login redirect loop");
    expect(goalRequest).not.toContain("<skill");

    await send("One more thing");
    await send("And another");
    expect(titleRequests).toHaveLength(2);
    expect(sessionNameSource(manager.getEntries())).toBe("auto-final");
    await service.dispose();
  });

  it("keeps a manual name at the fifth prompt and against checkpoint titles", async () => {
    const { service, send, titleRequests, manager } = titledSession(SessionManager.inMemory("/workspace"), ["Login fix", "Should not apply"]);

    await send("Fix the login redirect loop");
    await vi.waitFor(() => { expect(manager.getSessionName()).toBe("Login fix"); });
    await service.runCommand(sessionRef(SESSION_ID), "/name My auth work");
    for (const text of ["two", "three", "four", "five", "six"]) await send(text);
    await service.runCommand(sessionRef(SESSION_ID), "/workstream-checkpoint-title Auth checkpoint");

    expect(manager.getSessionName()).toBe("My auth work");
    expect(titleRequests).toHaveLength(1);
    expect(sessionNameSource(manager.getEntries())).toBe("manual");
    await service.dispose();
  });

  it("applies a checkpoint title over an automatic name and keeps it at the fifth prompt", async () => {
    const { service, send, titleRequests, manager } = titledSession(SessionManager.inMemory("/workspace"), ["Login fix", "Should not apply"]);

    await send("Fix the login redirect loop");
    await vi.waitFor(() => { expect(manager.getSessionName()).toBe("Login fix"); });
    await service.runCommand(sessionRef(SESSION_ID), `/workstream-checkpoint-title ${"Auth checkpoint ".repeat(10)}`);
    const checkpointName = manager.getSessionName();
    expect(checkpointName).toMatch(/^Auth checkpoint/);
    expect(checkpointName?.length).toBeLessThanOrEqual(80);
    for (const text of ["two", "three", "four", "five"]) await send(text);

    expect(manager.getSessionName()).toBe(checkpointName);
    expect(titleRequests).toHaveLength(1);
    expect(sessionNameSource(manager.getEntries())).toBe("checkpoint");
    await service.dispose();
  });

  it("keeps name provenance in the session file across reloads", async () => {
    const created = SessionManager.create("/workspace", sessionDir);
    const first = titledSession(created, ["Login fix"]);
    await first.send("Fix the login redirect loop");
    await vi.waitFor(() => { expect(created.getSessionName()).toBe("Login fix"); });
    await first.service.dispose();
    const file = created.getSessionFile() ?? "";

    expect(sessionNameSource(SessionManager.open(file, sessionDir).getEntries())).toBe("auto");

    const reopened = titledSession(SessionManager.open(file, sessionDir), ["Should not apply"]);
    await reopened.service.runCommand(sessionRef(SESSION_ID), "/name Owner title");
    await reopened.service.dispose();

    const reloaded = titledSession(SessionManager.open(file, sessionDir), ["Should not apply"]);
    expect(sessionNameSource(reloaded.manager.getEntries())).toBe("manual");
    await reloaded.service.runCommand(sessionRef(SESSION_ID), "/workstream-checkpoint-title Checkpoint title");
    for (const text of ["two", "three", "four", "five"]) await reloaded.send(text);
    expect(reloaded.manager.getSessionName()).toBe("Owner title");
    expect(reloaded.titleRequests).toEqual([]);
    await reloaded.service.dispose();
  });
});
