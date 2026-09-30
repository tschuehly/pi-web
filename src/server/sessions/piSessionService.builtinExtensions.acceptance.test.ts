import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime } from "./piSessionService.testSupport.js";

const tempDirs: string[] = [];
const services: PiSessionService[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Start a real PI WEB session with the given agent settings and return its SDK session. */
async function startSession(settings: object): Promise<{ session: AgentSession; hub: CapturingSessionEventHub }> {
  const agentDir = await tempDir("pi-web-builtin-agent-");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  // An invalid server entry, which the MCP extension reports from its session_start without connecting anything.
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "broken-probe": {} } }));
  vi.stubEnv("HOME", await tempDir("pi-web-builtin-home-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const register = vi.spyOn(PiSessionEventConnections.prototype, "register");
  const hub = new CapturingSessionEventHub();
  const service = new PiSessionService(hub, {
    agentDir,
    modelRuntime: await createTestModelRuntime(),
    sessionManager: createPiSessionManagerGateway({ agentDir, env: {} }),
    heartbeatIntervalMs: 60_000,
  });
  services.push(service);
  await service.start(await tempDir("pi-web-builtin-project-"));
  const session = register.mock.calls[0]?.[0];
  if (!(session instanceof AgentSession)) throw new Error("Expected a registered SDK session");
  return { session, hub };
}

describe("Pi built-in extensions in PI WEB sessions", () => {
  it("loads codemode, tool_search, and MCP, and binds MCP so it reads the configured servers", async () => {
    const { session, hub } = await startSession({});

    expect(session.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining(["builtin:codemode", "builtin:tool-search", "builtin:mcp"]));
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
    expect(session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName)).toContain("mcp");
    // Binding runs MCP's session_start, whose config report reaches the session notification inbox.
    expect(JSON.stringify(hub.sessionEvents)).toMatch(/MCP servers need attention:\\n {2}config: .*broken-probe/);
  });

  it("honors -builtin:<name> in the extensions setting", async () => {
    const { session } = await startSession({ extensions: ["-builtin:mcp"] });

    expect(session.extensionRunner.getExtensionPaths()).toEqual(expect.arrayContaining(["builtin:codemode", "builtin:tool-search"]));
    expect(session.extensionRunner.getExtensionPaths()).not.toContain("builtin:mcp");
  });
});
