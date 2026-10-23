import { cp, mkdir, readFile, writeFile, symlink, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import isolated from "../../isolatedPiWeb";

const HERE = dirname(fileURLToPath(import.meta.url));
export default async function setup() {
  const host = process.env["PI_WEB_E2E_DURABLE_HOST"];
  const packages = process.env["PI_WEB_E2E_PI_PACKAGES"];
  if (!host || !packages) throw new Error("Set PI_WEB_E2E_DURABLE_HOST and PI_WEB_E2E_PI_PACKAGES");
  process.env["FLEET_REAL_HOST"] = host;
  process.env["PI_WEB_E2E_DURABLE_HOST"] = join(HERE, "host.ts");
  // The shared harness uses os.tmpdir(); keep its socket short AND outside OS temporary storage.
  process.env["TMPDIR"] = join(homedir(), ".pi-workbench", "tmp");
  await mkdir(process.env["TMPDIR"], { recursive: true });
  const cleanup = await isolated();
  const root = dirname(process.env["PI_WEB_E2E_PROJECT_DIR"]!);
  process.env["FLEET_ROOT"] = root;
  const wb = resolve(dirname(host), "../../..");
  process.env["FLEET_WORKBENCH"] = wb;
  try {
    const copied = join(root, "packages");
    await mkdir(copied);
    // Only package code is copied, never the owner's settings, state, cookies or credentials.
    for (const name of ["pi-web-access", "ping-a-human-pi", "pi-process-monitor"])
      await cp(join(packages, name), join(copied, name), { recursive: true });
    await symlink(resolve(HERE, "../../../node_modules"), join(root, "node_modules"));
    const dependencies = new Set<string>();
    const copyDependencies = async (name: string): Promise<void> => {
      const manifest = JSON.parse(await readFile(join(packages, name, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependencies.has(dependency)) continue;
        dependencies.add(dependency);
        await cp(join(packages, dependency), join(copied, "node_modules", dependency), { recursive: true });
        await copyDependencies(dependency);
      }
    };
    await copyDependencies("pi-web-access");
    // BTW is installed from Git, not npm. Copy only its public package resources, never its checkout metadata.
    const btw = resolve(packages, "../../git/github.com/dbachelder/pi-btw");
    for (const resource of ["package.json", "extensions", "skills"]) await cp(join(btw, resource), join(copied, "pi-btw", resource), { recursive: true });
    const packagePaths = ["pi-web-access", "ping-a-human-pi", "pi-process-monitor", "pi-btw"].map((name) => join(copied, name));
    await writeFile(join(root, "durable-agent", "settings.json"), JSON.stringify({ packages: packagePaths, transport: "sse" }));
    await writeFile(join(root, "durable-agent", "models-store.json"), JSON.stringify({ anthropic: { models: [{ id: "claude-sonnet-5-5", reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } }] } }));
    // Resource-only fixtures: no owner extensions or global settings execute in this profile.
    const skills = ["atelier", "autonomous-grill", "define-goal", "model-orchestration", "orient", "workstreams", "analyze-source-for-workbench", "customize-pi-web-presentation", "gh-stack"];
    for (const name of skills) {
      const origin = name === "gh-stack" ? join(root, "agent") : join(copied, "resource-workbench");
      const dir = join(origin, "skills", name); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Fleet fixture ${name}\n${name === "customize-pi-web-presentation" ? "disable-model-invocation: true\n" : ""}---\n\nFixture skill body ${name}; see ./reference.md.\n`);
      await writeFile(join(dir, "reference.md"), `Reference for ${name}.\n`);
    }
    for (const name of ["resource-workbench"]) await writeFile(join(copied, name, "package.json"), JSON.stringify({ name: `fleet-${name}`, pi: { skills: ["./skills"], extensions: [] } }));
    const resourceSettings = join(root, "agent/settings.json");
    const previous = JSON.parse(await readFile(resourceSettings, "utf8"));
    await writeFile(resourceSettings, JSON.stringify({ ...previous, packages: [...(previous.packages ?? []), ...["pi-btw", "resource-workbench"].map((name) => ({ source: join(copied, name), extensions: [] }))] }));
    // One extra fixture extension inside an allowed copied package exercises generic status/resource hooks.
    const monitorManifest = join(copied, "pi-process-monitor/package.json");
    const manifest = JSON.parse(await readFile(monitorManifest, "utf8"));
    manifest.pi.extensions.push("./fleet-probe.ts");
    await writeFile(monitorManifest, JSON.stringify(manifest));
    await cp(join(HERE, "probe.ts"), join(copied, "pi-process-monitor/fleet-probe.ts"));
    await mkdir(join(root, "contributed-skill"));
    await writeFile(join(root, "contributed-skill/SKILL.md"), "---\nname: fleet-contributed\ndescription: Fixture extension contribution\n---\nContributed fixture content.\n");
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/__hits") { hits.pop(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(hits)); return; }
      if (req.url?.startsWith("/search")) {
        const q = new URL(req.url, "http://fixture").searchParams.get("q");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ results: [1, 2, 3].map((n) => ({ title: `${q} source ${n}`, url: `${origin}/page/${n}`, content: `Exact fixture evidence ${q} ${n}` })) }));
      } else {
        res.setHeader("content-type", "text/html");
        res.end(`<html><head><title>Fleet page</title></head><body><article><h1>Fixture evidence</h1><p>${"A bounded local paragraph. ".repeat(500)}NEEDLE-END</p></article></body></html>`);
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env["FLEET_WEB"] = origin;
    await writeFile(join(root, "durable-agent", "web-search.json"), JSON.stringify({
      provider: "searxng", searxngBaseUrl: origin, ssrf: { allowRanges: ["127.0.0.0/8"] },
      toolActivation: "dynamic", autoOpenBrowser: false, allowBrowserCookies: false,
      tools: { sourceCheck: { enabled: false } }, workflow: "none",
    }));
    await writeFile(join(root, "phone-config.json"), JSON.stringify({ command: process.execPath,
      args: [join(HERE, "phone-stub.mjs"), join(root, "phone.jsonl"), join(root, "phone-replies.json")],
      notify: { enabled: false }, approval: { enabled: false } }));
    await writeFile(join(root, "phone-replies.json"), "{}");
    await writeFile(join(root, "host-options.json"), JSON.stringify({ freeGb: 1000 }));
    const bin = join(root, "durable-agent", "bin");
    await mkdir(bin, { recursive: true });
    await symlink(join(wb, "skills/workstreams/scripts/workstreams.mjs"), join(bin, "workstreams"));
    for (const name of ["npx", "open", "security", "osascript", "claude"]) {
      const path = join(bin, name);
      await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${root}/forbidden.log'\nexit 77\n`);
      await chmod(path, 0o755);
    }
    // Persist sanitized fixture receipts before the shared teardown removes its root.
    return async () => {
      if (process.env["FLEET_EVIDENCE"]) {
        const dest = process.env["FLEET_EVIDENCE"]!;
        await mkdir(dest, { recursive: true });
        for (const name of ["phone.jsonl", "network.jsonl", "forbidden.log", "sessiond.log"])
          await writeFile(join(dest, name), await readFile(join(root, name), "utf8").catch(() => ""));
        await writeFile(join(dest, "web-hits.json"), JSON.stringify(hits, null, 2));
        await cp(join(root, "telemetry"), join(dest, "telemetry"), { recursive: true }).catch(() => undefined);
      }
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await cleanup();
    };
  } catch (error) { await cleanup(); throw error; }
}
