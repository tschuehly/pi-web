import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import setup from "../../isolatedPiWeb";

export default async function fleetSetup() {
  const host = process.env["PI_WEB_E2E_DURABLE_HOST"];
  if (!host) throw new Error("Set PI_WEB_E2E_DURABLE_HOST to the pinned Workbench chat-host-main.ts");
  process.env["DURABLE_FLEET_HOST"] = host;
  process.env["PI_WEB_E2E_DURABLE_HOST"] = fileURLToPath(new URL("./host.ts", import.meta.url));
  // This also puts HOME below the fixture root: legacy Worker registries must never touch the owner's registry.
  process.env["PI_WEB_E2E_PI_PACKAGES"] ??= join(homedir(), ".pi/agent/npm/node_modules");
  const cleanup = await setup();
  // The legacy comparison uses the real extension and the same mock-only agent profile as its children.
  const root = dirname(process.env["PI_WEB_E2E_PROJECT_DIR"]!);
  const workbench = resolve(dirname(host), "../../..");
  const settingsPath = join(root, "agent/settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.extensions.push(...["telemetry", "activity", "subagent", "pi-tmp", "tool-groups"].map((name) => join(workbench, "extensions", name, "index.ts")));
  await writeFile(settingsPath, JSON.stringify(settings));
  // The legacy router reads Pi's cached model catalog, not the model picker. Seed it from the installed provider definitions.
  await writeFile(join(root, "agent/models-store.json"), JSON.stringify(Object.fromEntries([anthropicProvider(), openaiCodexProvider()].map((provider) => [provider.id, { models: provider.getModels() }]))));
  return cleanup;
}
