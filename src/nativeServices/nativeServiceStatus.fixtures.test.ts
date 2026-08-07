import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type ServiceId = "sessiond" | "web" | "uiDev";

interface StatusFixture {
  name: string;
  serviceFiles: ServiceId[];
  observations: {
    manager: { label: string; pid: number; state: string }[];
    processes: { pid: number; ppid: number; executable: string; command: string }[];
    lock: unknown;
    socket: { state: "responsive" | "absent"; pid: number | null };
  };
  expected: Record<string, unknown>;
  expectedComponents?: Record<string, unknown>[];
  expectedLegacyProcessTrees?: Record<string, unknown>[];
}

interface FakeHostState {
  home: string;
  fixture: StatusFixture | null;
  runnerCalls: { command: string; args: string[] }[];
}

function createFakeHostState(): FakeHostState {
  return {
    home: "/tmp/pi-web-native-status-uninitialized",
    fixture: null,
    runnerCalls: [],
  };
}

const fakeHost = vi.hoisted(createFakeHostState);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => fakeHost.home,
    userInfo: () => ({ uid: 501, gid: 20, username: "fixture-user", homedir: fakeHost.home, shell: "/bin/zsh" }),
  };
});

vi.mock("../piWebVersionReport.js", () => ({
  packageVersion: () => "1.202607.3",
}));

vi.mock("../sessiond/sessiondOwnership.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../sessiond/sessiondOwnership.js")>();
  return {
    ...original,
    probeSessiondHealth: () => {
      const socket = fakeHost.fixture?.observations.socket;
      if (socket?.state === "responsive") {
        return Promise.resolve({ state: "responsive" as const, pid: socket.pid ?? undefined });
      }
      return Promise.resolve({ state: "stale" as const, detail: "fixture socket absent" });
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: (commandValue: unknown, argsValue: unknown) => {
      const command = String(commandValue);
      const args = Array.isArray(argsValue) ? argsValue.map(String) : [];
      fakeHost.runnerCalls.push({ command, args });
      const fixture = fakeHost.fixture;
      if (fixture === null) return commandResult(1, "", "fixture was not installed");

      if (command === "launchctl" && args[0] === "print") {
        const label = args.at(-1)?.split("/").at(-1);
        const managed = fixture.observations.manager.find((item) => item.label === label);
        return managed === undefined
          ? commandResult(113, "", "Could not find service in domain")
          : commandResult(0, `state = ${managed.state}\npid = ${String(managed.pid)}\n`, "");
      }
      if (command === "ps") {
        const stdout = fixture.observations.processes
          .map((process) => `${String(process.pid)} ${String(process.ppid)} ${process.executable} ${process.command}`)
          .join("\n");
        return commandResult(0, `${stdout}\n`, "");
      }
      if (command === "kill" && args[0] === "-0") {
        const pid = Number(args[1]);
        return commandResult(fixture.observations.processes.some((process) => process.pid === pid) ? 0 : 1, "", "");
      }
      return commandResult(127, "", `Unexpected fixture command: ${command} ${args.join(" ")}`);
    },
  };
});

const fixtureNames = ["managed", "unmanaged", "duplicate", "stale-lock", "conflict"] as const;
const generalizedFixtureNames = [
  "web-duplicate",
  "ui-dev-duplicate",
  "partial-health",
  "managed-descendant-chains",
  "legacy-workbench-trees",
] as const;
const originalArgv = [...process.argv];
const originalDataDir = process.env["PI_WEB_DATA_DIR"];
const originalSocketPath = process.env["PI_WEB_SESSIOND_SOCKET"];
let fixtureRoot: string | undefined;

afterEach(async () => {
  process.argv = [...originalArgv];
  process.exitCode = undefined;
  if (originalDataDir === undefined) delete process.env["PI_WEB_DATA_DIR"];
  else process.env["PI_WEB_DATA_DIR"] = originalDataDir;
  if (originalSocketPath === undefined) delete process.env["PI_WEB_SESSIOND_SOCKET"];
  else process.env["PI_WEB_SESSIOND_SOCKET"] = originalSocketPath;
  fakeHost.fixture = null;
  fakeHost.runnerCalls.length = 0;
  vi.restoreAllMocks();
  vi.resetModules();
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe("pi-web status --json ownership fixtures", () => {
  it.each(fixtureNames)("reports the %s sessiond fixture without flattening ownership or instances", async (fixtureName) => {
    const fixture = await loadFixture(fixtureName);
    await installFixture(fixture);

    const stdout = await runCliJson("status");
    const report = parseCliJson(stdout, `status fixture ${fixture.name}`);
    const components = report["components"];
    expect(Array.isArray(components)).toBe(true);
    if (!Array.isArray(components)) throw new Error("Expected status components");
    const componentValues: unknown[] = components;
    const sessiond = componentValues.find((component) => isRecord(component) && component["component"] === "sessiond");

    expect(sessiond).toMatchObject(fixture.expected);
  });

  it.each(generalizedFixtureNames)("reports every component and instance in the %s fixture", async (fixtureName) => {
    const fixture = await loadFixture(fixtureName);
    await installFixture(fixture);

    const report = parseCliJson(await runCliJson("status"), `status fixture ${fixture.name}`);
    const components = report["components"];
    expect(Array.isArray(components)).toBe(true);
    if (!Array.isArray(components)) throw new Error("Expected status components");

    expect(components.map((component) => isRecord(component) ? component["component"] : undefined))
      .toEqual(fixture.expectedComponents?.map((component) => component["component"]));
    expect(components).toMatchObject(fixture.expectedComponents ?? []);
    if (fixture.expectedLegacyProcessTrees !== undefined) {
      expect(report["legacyProcessTrees"]).toMatchObject(fixture.expectedLegacyProcessTrees);
    }
  });

  it("emits attended doctor JSON for unmanaged duplicates without sending a signal", async () => {
    const fixture = await loadFixture("duplicate");
    await installFixture(fixture);

    const report = parseCliJson(await runCliJson("doctor"), "duplicate doctor fixture");

    expect(report).toMatchObject({
      ok: false,
      conflicts: [{
        component: "sessiond",
        kind: "unmanaged-process-conflict",
        cleanup: { attended: true, requiresAcknowledgement: true, performed: false },
      }],
    });
    expect(fakeHost.runnerCalls.some((call) => call.command === "kill" && call.args[0] !== "-0")).toBe(false);
  });

  it("emits attended doctor JSON for the two legacy Workbench trees without sending a signal", async () => {
    const fixture = await loadFixture("legacy-workbench-trees");
    await installFixture(fixture);

    const report = parseCliJson(await runCliJson("doctor"), "legacy Workbench doctor fixture");

    expect(report).toMatchObject({
      ok: false,
      conflicts: [{
        component: "legacy-wrapper",
        kind: "legacy-wrapper-conflict",
        processTrees: fixture.expectedLegacyProcessTrees,
        cleanup: { attended: true, requiresAcknowledgement: true, performed: false },
      }],
    });
    expect(fakeHost.runnerCalls.some((call) => call.command === "kill" && call.args[0] !== "-0")).toBe(false);
  });
});

async function loadFixture(name: typeof fixtureNames[number] | typeof generalizedFixtureNames[number]): Promise<StatusFixture> {
  const path = fileURLToPath(new URL(`./testFixtures/nativeServiceStatus/${name}.json`, import.meta.url));
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isStatusFixture(parsed)) throw new Error(`Invalid native-service status fixture: ${path}`);
  return parsed;
}

async function installFixture(fixture: StatusFixture): Promise<void> {
  fixtureRoot = await mkdtemp(join(tmpdir(), `pi-web-native-status-${fixture.name}-`));
  fakeHost.home = join(fixtureRoot, "home");
  fakeHost.fixture = fixture;
  const serviceNames = {
    sessiond: "com.pi-web.sessiond.plist",
    web: "com.pi-web.web.plist",
    uiDev: "com.pi-web.ui-dev.plist",
  } as const;
  for (const id of fixture.serviceFiles) {
    const path = join(fakeHost.home, "Library", "LaunchAgents", serviceNames[id]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture service definition\n", "utf8");
  }

  const dataDir = join(fixtureRoot, "data");
  await mkdir(dataDir, { recursive: true });
  process.env["PI_WEB_DATA_DIR"] = dataDir;
  process.env["PI_WEB_SESSIOND_SOCKET"] = join(dataDir, "sessiond.sock");
  await writeFile(join(dataDir, "sessiond.lock"), `${JSON.stringify(fixture.observations.lock)}\n`, "utf8");
}

async function runCliJson(command: "status" | "doctor"): Promise<string> {
  const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
  process.argv = [process.execPath, cliPath, command, "--json"];
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  vi.resetModules();
  await import("../cli.js");
  await vi.waitFor(() => {
    expect(log.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0);
  });

  return log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function parseCliJson(stdout: string, scenario: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed)) return parsed;
  } catch {
    // The explicit error below preserves unexpected CLI output in the failure.
  }
  throw new Error(`Expected pi-web --json output for ${scenario}. Received:\n${stdout}`);
}

function commandResult(status: number, stdout: string, stderr: string): { status: number; stdout: string; stderr: string; error: undefined } {
  return { status, stdout, stderr, error: undefined };
}

function isStatusFixture(value: unknown): value is StatusFixture {
  if (!isRecord(value) || typeof value["name"] !== "string" || !isRecord(value["observations"]) || !isRecord(value["expected"])) return false;
  const serviceFiles = value["serviceFiles"];
  const manager = value["observations"]["manager"];
  const processes = value["observations"]["processes"];
  const expectedComponents = value["expectedComponents"];
  const expectedLegacyProcessTrees = value["expectedLegacyProcessTrees"];
  return Array.isArray(serviceFiles)
    && serviceFiles.every(isServiceId)
    && Array.isArray(manager)
    && manager.every(isManagerObservation)
    && Array.isArray(processes)
    && processes.every(isProcessObservation)
    && "lock" in value["observations"]
    && isSocketObservation(value["observations"]["socket"])
    && (expectedComponents === undefined || (Array.isArray(expectedComponents) && expectedComponents.every(isRecord)))
    && (expectedLegacyProcessTrees === undefined
      || (Array.isArray(expectedLegacyProcessTrees) && expectedLegacyProcessTrees.every(isRecord)));
}

function isSocketObservation(value: unknown): value is StatusFixture["observations"]["socket"] {
  return isRecord(value)
    && (value["state"] === "responsive" || value["state"] === "absent")
    && (typeof value["pid"] === "number" || value["pid"] === null);
}

function isServiceId(value: unknown): value is ServiceId {
  return value === "sessiond" || value === "web" || value === "uiDev";
}

function isManagerObservation(value: unknown): value is StatusFixture["observations"]["manager"][number] {
  return isRecord(value)
    && typeof value["label"] === "string"
    && typeof value["pid"] === "number"
    && typeof value["state"] === "string";
}

function isProcessObservation(value: unknown): value is StatusFixture["observations"]["processes"][number] {
  return isRecord(value)
    && typeof value["pid"] === "number"
    && typeof value["ppid"] === "number"
    && typeof value["executable"] === "string"
    && typeof value["command"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
