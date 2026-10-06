import { describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

describe("PiSessionService", () => {
  describe("assistant thinking-level attribution", () => {
    function messagesService(branch: unknown[], patch: Parameters<typeof fakeRuntime>[1] = {}, events = new CapturingSessionEventHub()) {
      const fake = fakeRuntime("session-1", {
        sessionFile: "/tmp/session-1.jsonl",
        sessionManager: fakeSessionManager("/workspace", { getBranch: () => branch }),
        ...patch,
      });
      const service = new PiSessionService(events, {
        agentDir: TEST_AGENT_DIR,
        modelRuntime: testModelRuntime,
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("session-1")]),
        heartbeatIntervalMs: 60_000,
      });
      return { fake, service, events };
    }

    it("projects history and completed events, but leaves streaming deltas and reconnect partials original", async () => {
      const message = { role: "assistant", content: [{ type: "text", text: "<think></think>answer" }] };
      const branch = [{ type: "message", message }];
      const { fake, service, events } = messagesService(branch, { state: { streamingMessage: message } });
      fake.session.extensionRunner.getMarkdownTransformers = () => [(text) => text.replace("<think></think>", "")];
      const projected = { role: "assistant", content: [{ type: "text", text: "<think></think>answer", displayText: "answer" }] };
      try {
        expect((await service.messages(sessionRef("session-1"))).messages).toEqual([projected]);
        fake.emit({ type: "message_end", message });
        fake.emit({ type: "entry_appended", entry: { type: "message", message } });
        fake.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "<think>" } });
        // message_end publication waits one microtask for its persisted entry id.
        await Promise.resolve();
        expect(events.sessionEvents.map(({ event }) => event)).toEqual(expect.arrayContaining([
          { type: "message.end", message: projected },
          { type: "message.append", message: projected },
          { type: "assistant.delta", text: "<think>" },
        ]));
        expect((await service.streamSnapshot(sessionRef("session-1"))).partial).toEqual(message);
        expect(message.content[0]).toEqual({ type: "text", text: "<think></think>answer" });
        // Resolve the current runner chain each time, including after extension reload.
        fake.session.extensionRunner.getMarkdownTransformers = () => [];
        expect((await service.messages(sessionRef("session-1"))).messages).toEqual([message]);
      } finally {
        await service.dispose();
      }
    });

    it("annotates paged assistant messages with the thinking level in effect from branch entries", async () => {
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "before any entry" }] } },
        { type: "thinking_level_change", thinkingLevel: "medium" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "first answer" }] } },
        { type: "thinking_level_change", thinkingLevel: "max" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "second answer" }] } },
        { type: "thinking_level_change", thinkingLevel: "off" },
        { type: "message", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "unthinking answer" }] } },
        { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }] } },
      ];
      const { service } = messagesService(branch);

      const page = await service.messages(sessionRef("session-1"));

      expect(page).toEqual({
        start: 0,
        total: 6,
        messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "before any entry" }] },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "first answer" }], thinkingLevel: "medium" },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "second answer" }], thinkingLevel: "max" },
        { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "unthinking answer" }] },
        { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "done" }] },
        ],
      });
      await service.dispose();
    });

    it("annotates live assistant message.end events with the session's current thinking level", async () => {
      const { fake, service, events } = messagesService([], { thinkingLevel: "high" });
      await service.status(sessionRef("session-1")); // bring the session online so it publishes events

      fake.emit({ type: "message_end", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "answer" }] } });
      fake.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "next" }] } });
      await Promise.resolve();

      const messageEnds = events.sessionEvents.map(({ event }) => event).filter((event) => event.type === "message.end");
      expect(messageEnds).toEqual([
        { type: "message.end", message: { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "answer" }], thinkingLevel: "high" } },
        { type: "message.end", message: { role: "user", content: [{ type: "text", text: "next" }] } },
      ]);
      await service.dispose();
    });

    it("suppresses display:false custom messages but preserves other custom messages live", async () => {
      const { fake, service, events } = messagesService([]);
      await service.status(sessionRef("session-1"));
      const eventStart = events.sessionEvents.length;
      const messages = [
        { role: "custom", customType: "goal-contract", content: "hidden goal context", display: false, details: { version: 2, goalId: "goal-1" } },
        { role: "custom", customType: "other.hidden", content: "hidden extension context", display: false, details: { source: "other" } },
        { role: "custom", customType: "other.default", content: "implicit extension context", details: { source: "other" } },
        { role: "custom", customType: "pi-goal.lifecycle", content: "Goal resumed", display: true, details: { schemaVersion: 1, goalId: "goal-1", transition: "resume", state: "active", reason: "Owner approved" } },
        { role: "custom", customType: "other.visible", content: "visible extension message", display: true, details: { source: "other" } },
      ];
      const original = structuredClone(messages);

      for (const message of messages) fake.emit({ type: "message_end", message });
      await Promise.resolve();

      expect(events.sessionEvents.slice(eventStart).flatMap(({ event }) => event.type === "message.end" ? [event.message] : [])).toEqual([
        messages[2],
        messages[3],
        messages[4],
      ]);
      expect(messages).toEqual(original);
      await service.dispose();
    });

    it("publishes the durable transcript entry id with a finalized live message", async () => {
      const entryId = "assistant-entry";
      const message = { role: "assistant", provider: "openai", model: "gpt-4.1", content: [{ type: "text", text: "answer" }] };
      const branch: unknown[] = [];
      const { fake, service, events } = messagesService(branch);
      await service.status(sessionRef("session-1"));
      const eventStart = events.sessionEvents.length;

      fake.emit({ type: "message_end", message });
      branch.push({ type: "message", id: entryId, message });
      fake.emit({ type: "turn_end" });
      await Promise.resolve();

      const liveEvents = events.sessionEvents.slice(eventStart);
      expect(liveEvents[0]).toEqual({ sessionId: "session-1", event: { type: "message.end", message: { ...message, entryId } } });
      expect(liveEvents.findIndex(({ event }) => event.type === "pi.event" && event.eventType === "turn_end")).toBeGreaterThan(0);
      expect((await service.messages(sessionRef("session-1"))).messages).toEqual([{ ...message, entryId }]);
      await service.dispose();
    });

    it("publishes the matching durable entry id when another entry displaces it before publication", async () => {
      const message = { role: "assistant", content: [{ type: "text", text: "answer" }] };
      const branch: unknown[] = [];
      const { fake, service, events } = messagesService(branch);
      await service.status(sessionRef("session-1"));
      const eventStart = events.sessionEvents.length;

      fake.emit({ type: "message_end", message });
      branch.push({ type: "message", id: "answer-entry", message });
      branch.push({ type: "message", id: "later-entry", message: { role: "user", content: "next" } });
      await Promise.resolve();

      expect(events.sessionEvents.slice(eventStart)[0]).toEqual({ sessionId: "session-1", event: {
        type: "message.end", message: { ...message, entryId: "answer-entry" },
      } });
      expect((await service.messages(sessionRef("session-1"))).messages[0]).toEqual({ ...message, entryId: "answer-entry" });
      await service.dispose();
    });

    it("omits entryId when a deeper durable message has matching content but different identity", async () => {
      const staleMessage = { role: "assistant", content: [{ type: "text", text: "current" }] };
      const branch = [
        { type: "message", id: "stale-entry", message: staleMessage },
        { type: "message", id: "later-entry", message: { role: "user", content: "next" } },
      ];
      const message = { role: "assistant", entryId: "raw-entry", content: [{ type: "text", text: "current" }] };
      const { fake, service, events } = messagesService(branch);
      await service.status(sessionRef("session-1"));
      const eventStart = events.sessionEvents.length;

      fake.emit({ type: "message_end", message });
      await Promise.resolve();

      expect(events.sessionEvents.slice(eventStart)[0]).toEqual({ sessionId: "session-1", event: {
        type: "message.end",
        message: { role: "assistant", content: [{ type: "text", text: "current" }] },
      } });
      await service.dispose();
    });

    it("does not publish a deferred finalized message after disposal", async () => {
      const message = { role: "assistant", content: [{ type: "text", text: "answer" }] };
      const branch = [{ type: "message", id: "assistant-entry", message }];
      const { fake, service, events } = messagesService(branch);
      await service.status(sessionRef("session-1"));
      const eventStart = events.sessionEvents.length;

      fake.emit({ type: "message_end", message });
      await service.dispose();
      await Promise.resolve();

      expect(events.sessionEvents.slice(eventStart).filter(({ event }) => event.type === "message.end")).toEqual([]);
    });

    it("contains deferred publication failures", async () => {
      let failPublications = false;
      const events = new class extends CapturingSessionEventHub {
        override publish(sessionId: string, event: Parameters<CapturingSessionEventHub["publish"]>[1]): void {
          if (failPublications) throw new Error("publication failed");
          super.publish(sessionId, event);
        }
      }();
      const { fake, service } = messagesService([], {}, events);
      await service.status(sessionRef("session-1"));
      failPublications = true;

      fake.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } });
      await Promise.resolve();

      await service.dispose();
    });

    it("annotates the join-time stream snapshot partial with the current thinking level", async () => {
      const streamingMessage = {
        role: "assistant",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "provider-signature" }],
      };
      const { service } = messagesService([], { thinkingLevel: "xhigh", state: { streamingMessage } });

      const snapshot = await service.streamSnapshot(sessionRef("session-1"));

      expect(snapshot.partial).toEqual({
        role: "assistant",
        provider: "openai",
        model: "gpt-4.1",
        content: [{ type: "thinking", thinking: "hmm" }],
        thinkingLevel: "xhigh",
      });
      await service.dispose();
    });
  });
});
