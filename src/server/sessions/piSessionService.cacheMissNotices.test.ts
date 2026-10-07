import { describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRef, TEST_MODEL_ID, TEST_MODEL_PROVIDER, testModelRuntime } from "./piSessionService.testSupport.js";

const MINUTE = 60_000;
const NOTICE = "Cache miss after 10m idle: 51k tokens re-billed (~$0.14)";

function assistant(timestamp: number, usage: { input: number; cacheRead: number; cacheWrite: number }) {
  return {
    role: "assistant",
    provider: TEST_MODEL_PROVIDER,
    model: TEST_MODEL_ID,
    content: [{ type: "text", text: "answer" }],
    stopReason: "stop",
    timestamp,
    usage: {
      ...usage,
      output: 10,
      totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + 10,
      // Anthropic Sonnet rates: $3/M input, $3.75/M cache write, $0.30/M cache read.
      cost: { input: usage.input * 3e-6, output: 0, cacheRead: usage.cacheRead * 0.3e-6, cacheWrite: usage.cacheWrite * 3.75e-6, total: 0 },
    },
  };
}

const warmTurn = assistant(0, { input: 1_000, cacheRead: 0, cacheWrite: 50_000 });
const missedTurn = assistant(10 * MINUTE, { input: 51_000, cacheRead: 0, cacheWrite: 0 });
const priorEntries = [
  { type: "message", id: "u1", message: { role: "user", content: "hi", timestamp: 0 } },
  { type: "message", id: "a1", message: warmTurn },
];

async function startService(branch: unknown[], showCacheMissNotices: boolean) {
  const hub = new CapturingSessionEventHub();
  const fake = fakeRuntime("cache-session", {
    sessionManager: fakeSessionManager("/workspace", { getBranch: () => branch }),
  });
  fake.session.settingsManager.getShowCacheMissNotices = () => showCacheMissNotices;
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([]),
    heartbeatIntervalMs: 60_000,
  });
  await service.start("/workspace");
  return { hub, fake, service };
}

function cacheEvents(hub: CapturingSessionEventHub) {
  return {
    messageEnd: hub.sessionEvents.map(({ event }) => event).find((event) => event.type === "message.end"),
    notifications: hub.sessionEvents.map(({ event }) => event).filter((event) => event.type === "notifications.inbox"),
  };
}

describe("PiSessionService prompt cache-miss notices", () => {
  it("annotates the live assistant turn and raises a warning notification", async () => {
    const { hub, fake, service } = await startService(priorEntries, true);
    try {
      fake.emit({ type: "message_end", message: missedTurn });
      await Promise.resolve();
      const { messageEnd, notifications } = cacheEvents(hub);
      expect(messageEnd).toMatchObject({ type: "message.end", message: { role: "assistant", cacheMissNotice: NOTICE } });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ delta: { kind: "added", notification: { message: NOTICE, severity: "warning" } } });
    } finally {
      await service.dispose();
    }
  });

  it("re-derives the notice onto the paying assistant turn in history", async () => {
    const { service } = await startService([...priorEntries, { type: "message", id: "a2", message: missedTurn }], true);
    try {
      const { messages } = await service.messages(sessionRef("cache-session"));
      expect(messages).toHaveLength(3);
      expect(messages[1]).not.toHaveProperty("cacheMissNotice");
      expect(messages[2]).toMatchObject({ entryId: "a2", cacheMissNotice: NOTICE });
      const snapshot = await service.transcriptSnapshot(sessionRef("cache-session"));
      expect(snapshot.page.messages.at(-1)).toMatchObject({ entryId: "a2", cacheMissNotice: NOTICE });
    } finally {
      await service.dispose();
    }
  });

  it("shows nothing when showCacheMissNotices is off", async () => {
    const { hub, fake, service } = await startService([...priorEntries, { type: "message", id: "a2", message: missedTurn }], false);
    try {
      fake.emit({ type: "message_end", message: missedTurn });
      await Promise.resolve();
      const { messageEnd, notifications } = cacheEvents(hub);
      expect(messageEnd).toMatchObject({ type: "message.end" });
      expect(messageEnd).not.toHaveProperty("message.cacheMissNotice");
      expect(notifications).toEqual([]);
      const { messages } = await service.messages(sessionRef("cache-session"));
      for (const message of messages) expect(message).not.toHaveProperty("cacheMissNotice");
    } finally {
      await service.dispose();
    }
  });
});
