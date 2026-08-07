import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRuntimeState {
  nextOwner: string;
  ownersBySocket: Map<string, string>;
  servers: Server[];
  tcpStarts: number;
}

function createFakeRuntimeState(): FakeRuntimeState {
  return {
    nextOwner: "direct",
    ownersBySocket: new Map(),
    servers: [],
    tcpStarts: 0,
  };
}

const fakeRuntime = vi.hoisted(createFakeRuntimeState);

vi.mock("fastify", () => ({
  default: () => ({
    log: {
      error: vi.fn(),
      info: vi.fn(),
    },
    register: vi.fn(() => Promise.resolve()),
    get: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    listen: vi.fn(async (options: { path?: string; port?: number }) => {
      const socketPath = options.path;
      if (socketPath === undefined) {
        if (options.port === undefined) throw new Error("Expected a Unix socket path or TCP port");
        fakeRuntime.tcpStarts += 1;
        return;
      }
      const owner = fakeRuntime.nextOwner;
      const server = createServer((request, response) => {
        if (request.url === "/health") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true, owner }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      fakeRuntime.servers.push(server);
      fakeRuntime.ownersBySocket.set(socketPath, owner);
    }),
  }),
}));
vi.mock("@fastify/websocket", () => ({ default: vi.fn() }));
vi.mock("./activity/workspaceActivityService.js", () => ({ WorkspaceActivityService: class { readonly fixture = true; } }));
vi.mock("./activity/workspaceActivityRoutes.js", () => ({ registerWorkspaceActivityRoutes: vi.fn() }));
vi.mock("./realtime/sessionEventHub.js", () => ({ SessionEventHub: class { readonly fixture = true; } }));
vi.mock("./sessions/authService.js", () => ({
  AuthService: {
    create: () => Promise.resolve({ runtime: {}, subscribe: vi.fn(), dispose: vi.fn() }),
  },
}));
vi.mock("./sessions/globalProviderPolicy.js", () => ({ bootstrapAndFreezeGlobalExtensionProviders: vi.fn(() => Promise.resolve()) }));
vi.mock("./sessions/authRoutes.js", () => ({ registerAuthRoutes: vi.fn() }));
vi.mock("./sessions/modelCatalogRefresher.js", () => ({
  ModelCatalogRefresher: class {
    start() { return undefined; }
    requestRefresh() { return undefined; }
    dispose() { return undefined; }
  },
}));
vi.mock("./sessions/piSessionService.js", () => ({
  PiSessionService: class {
    activeCount() { return 0; }
    applyAuthChange() { return undefined; }
    dispose() { return Promise.resolve(); }
  },
}));
vi.mock("./sessions/piSessionManagerGateway.js", () => ({ createPiSessionManagerGateway: vi.fn(() => ({})) }));
vi.mock("./sessions/sessionRoutes.js", () => ({ registerSessionRoutes: vi.fn() }));
vi.mock("./sessions/sessionNotificationStore.js", () => ({ SessionNotificationStore: class { readonly fixture = true; } }));
vi.mock("./sessions/sessionUnreadStore.js", () => ({
  defaultSessionUnreadFilePath: vi.fn(() => "/tmp/fake-session-unread.json"),
  FileSessionUnreadPersistence: class { readonly fixture = true; },
  SessionUnreadStore: class {
    load() { return Promise.resolve(); }
    flush() { return Promise.resolve(); }
  },
}));
vi.mock("./sessions/spawnTargetResolver.js", () => ({ ProjectScopedSpawnTargetResolver: class { readonly fixture = true; } }));
vi.mock("./workspaces/projectWorkspaceCwds.js", () => ({ RegisteredProjectWorkspaceCwds: class { readonly fixture = true; } }));
vi.mock("./projects/projectService.js", () => ({ ProjectService: class { readonly fixture = true; } }));
vi.mock("./storage/projectStore.js", () => ({
  ProjectStore: class { readonly fixture = true; },
  projectStorePath: vi.fn(() => "/tmp/fake-projects.json"),
}));
vi.mock("./workspaces/workspaceService.js", () => ({ WorkspaceService: class { readonly fixture = true; } }));
vi.mock("./terminals/terminalService.js", () => ({
  TerminalService: class {
    dispose() { return undefined; }
  },
}));
vi.mock("./terminals/terminalRoutes.js", () => ({ registerTerminalRoutes: vi.fn() }));
vi.mock("./piWebStatus.js", () => ({
  getPiWebRuntimeComponent: () => ({ component: "sessiond", label: "test", available: true }),
}));
vi.mock("../shared/capabilities.js", () => ({ SESSIOND_RUNTIME_CAPABILITIES: [] }));
vi.mock("../config.js", () => ({
  agentSessionDirEnvKeys: () => [],
  effectivePiWebConfig: () => ({
    config: {
      agent: { command: "pi", dir: "/tmp/fake-agent" },
      askUser: true,
      extensionDialogsTimeoutMs: 1_000,
      spawnSessions: false,
      subsessions: false,
    },
  }),
  maxUploadBytes: () => 1_024,
  offlineModeEnabled: () => true,
  piWebDataDir: (env: NodeJS.ProcessEnv) => env["PI_WEB_DATA_DIR"] ?? "/tmp/fake-pi-web-data",
}));
vi.mock("../sessiond/activeAgentProfile.js", () => ({
  createActiveAgentProfileDescriptor: () => ({ command: "pi", dir: "/tmp/fake-agent", sessionDirEnvKeys: [] }),
}));
vi.mock("./sessiond/sessionServiceDependencies.js", () => ({ sessionServiceDependencies: () => ({}) }));

const originalSocketPath = process.env["PI_WEB_SESSIOND_SOCKET"];
const originalPort = process.env["PI_WEB_SESSIOND_PORT"];
let fixtureRoot: string | undefined;
let configuredSocketPath: string | undefined;

async function closeFakeServers(): Promise<void> {
  const servers = fakeRuntime.servers.splice(0);
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.close(() => { resolve(); });
  })));
}

beforeEach(() => {
  // The imported entrypoint normally registers host signal/exit hooks. Keep this
  // fake-process harness local so no test owns the Vitest worker lifecycle.
  vi.spyOn(process, "once").mockImplementation(() => process);
  vi.spyOn(process, "on").mockImplementation(() => process);
});

afterEach(async () => {
  await closeFakeServers();
  fakeRuntime.ownersBySocket.clear();
  fakeRuntime.tcpStarts = 0;
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalSocketPath === undefined) delete process.env["PI_WEB_SESSIOND_SOCKET"];
  else process.env["PI_WEB_SESSIOND_SOCKET"] = originalSocketPath;
  if (originalPort === undefined) delete process.env["PI_WEB_SESSIOND_PORT"];
  else process.env["PI_WEB_SESSIOND_PORT"] = originalPort;
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
  configuredSocketPath = undefined;
});

describe("session daemon socket ownership", () => {
  it("does not let a second direct start unlink or steal the first direct start's live socket", async () => {
    const socketPath = await isolatedSocketPath();
    fakeRuntime.nextOwner = "direct:4101";
    await startSessionDaemon();

    fakeRuntime.nextOwner = "direct:4102";
    const failure = await startSessionDaemon().then(() => undefined, (error: unknown) => error);

    expect({
      code: errorCode(failure),
      owner: fakeRuntime.ownersBySocket.get(socketPath),
    }).toEqual({
      code: "SESSIOND_DUPLICATE_OWNER",
      owner: "direct:4101",
    });
  });

  it("does not let a direct start unlink or steal a managed daemon's live socket", async () => {
    const socketPath = await isolatedSocketPath();
    await bindFakeOwner(socketPath, "launchd:com.pi-web.sessiond:5101");

    fakeRuntime.nextOwner = "direct:5102";
    const failure = await startSessionDaemon().then(() => undefined, (error: unknown) => error);

    expect({
      code: errorCode(failure),
      owner: fakeRuntime.ownersBySocket.get(socketPath),
    }).toEqual({
      code: "SESSIOND_DUPLICATE_OWNER",
      owner: "launchd:com.pi-web.sessiond:5101",
    });
  });

  it("preserves explicitly configured TCP-port mode without claiming Unix socket ownership", async () => {
    const socketPath = await isolatedSocketPath();
    await bindFakeOwner(socketPath, "unix-owner:5201");
    process.env["PI_WEB_SESSIOND_PORT"] = "18504";

    await expect(startSessionDaemon()).resolves.toBeUndefined();

    expect(fakeRuntime.tcpStarts).toBe(1);
    expect(fakeRuntime.ownersBySocket.get(socketPath)).toBe("unix-owner:5201");
  });
});

async function isolatedSocketPath(): Promise<string> {
  fixtureRoot = await mkdtemp(join(tmpdir(), "pi-web-sessiond-contention-"));
  const socketPath = join(fixtureRoot, "sessiond.sock");
  configuredSocketPath = socketPath;
  process.env["PI_WEB_SESSIOND_SOCKET"] = socketPath;
  delete process.env["PI_WEB_SESSIOND_PORT"];
  return socketPath;
}

async function startSessionDaemon(): Promise<void> {
  // Each import represents a separate daemon process launched with the same
  // configured socket. The real daemon scrubs its own process.env after
  // capturing daemonEnvironment; that must not mutate a later process's env.
  if (configuredSocketPath !== undefined) process.env["PI_WEB_SESSIOND_SOCKET"] = configuredSocketPath;
  vi.resetModules();
  await import("./sessiond.js");
}

function errorCode(value: unknown): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, "code") : undefined;
}

async function bindFakeOwner(socketPath: string, owner: string): Promise<void> {
  fakeRuntime.nextOwner = owner;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, owner }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fakeRuntime.servers.push(server);
  fakeRuntime.ownersBySocket.set(socketPath, owner);
}
