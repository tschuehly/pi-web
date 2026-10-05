import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createTestModelRuntime, testModel } from "./sessions/piSessionService.testSupport.js";

// Guards patches/@earendil-works+pi-coding-agent+*.patch (https://github.com/earendil-works/pi/issues/8773):
// an idle sendCustomMessage({ triggerTurn: true }) run must fire before_agent_start like prompt() does.
describe("Pi SDK before_agent_start for custom-message runs", () => {
  it("fires before_agent_start and applies its system prompt for triggerTurn custom messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-8773-"));
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const hookPrompts: string[] = [];
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [(pi) => {
        pi.on("before_agent_start", (event) => {
          hookPrompts.push(event.prompt);
          return { systemPrompt: `${event.systemPrompt}\n\nrun override` };
        });
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      sessionManager: SessionManager.inMemory(directory),
      settingsManager,
      resourceLoader: loader,
      modelRuntime,
      model: testModel(),
      noTools: "all",
    });
    const providerSystemPrompts: string[] = [];
    session.agent.streamFunction = (_model, context) => {
      // Pi 0.99 projects a forced system prompt as the leading system message.
      providerSystemPrompts.push(JSON.stringify(context.messages.filter((message) => message.role === "system")));
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic-messages", provider: "anthropic", model: testModel().id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    try {
      await session.prompt("start");
      await session.sendCustomMessage(
        { customType: "background-completion", content: [{ type: "text", text: "collect" }, { type: "text", text: "now" }], display: false },
        { triggerTurn: true },
      );
      expect(hookPrompts).toEqual(["start", "collect\nnow"]);
      expect(providerSystemPrompts).toHaveLength(2);
      for (const systemPrompt of providerSystemPrompts) expect(systemPrompt).toContain("run override");
    } finally {
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
