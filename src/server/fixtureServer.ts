#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppDependencies } from "./app.js";
import { MachineService } from "./machines/machineService.js";
import { MachineStore } from "./machines/machineStore.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { buildControlledSessionFixture, type ControlledSessionFixture } from "./controlledSessionFixture.js";

export interface ControlledFixtureServerOptions {
  root: string;
  projectsFile: string;
  machinesFile: string;
  sessionDir: string;
  manifestFile: string;
  clientDist: string | false;
  appDependencies?: Omit<AppDependencies, "clientDist">;
}

export async function buildControlledFixtureServer(options: ControlledFixtureServerOptions): Promise<{ app: FastifyInstance; fixture: ControlledSessionFixture }> {
  const fixture = await buildControlledSessionFixture(options);
  assertOwnedManifest(options.root, options.manifestFile);
  await mkdir(dirname(options.manifestFile), { recursive: true });
  await writeFile(options.manifestFile, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  const app = await buildApp({
    projects: new ProjectService(new ProjectStore(options.projectsFile)),
    workspaces: new WorkspaceService(),
    machines: new MachineService(new MachineStore(options.machinesFile)),
    ...options.appDependencies,
    clientDist: options.clientDist,
  });
  return { app, fixture };
}

export function controlledFixtureServerOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ControlledFixtureServerOptions {
  return {
    root: requiredEnv(env, "PI_WEB_FIXTURE_OWNED_ROOT"),
    projectsFile: requiredEnv(env, "PI_WEB_PROJECTS_FILE"),
    machinesFile: requiredEnv(env, "PI_WEB_MACHINES_FILE"),
    sessionDir: requiredEnv(env, "PI_WEB_AGENT_SESSION_DIR"),
    manifestFile: requiredEnv(env, "PI_WEB_FIXTURE_MANIFEST"),
    clientDist: resolve(cwd, "dist/client"),
  };
}

async function main(): Promise<void> {
  const options = controlledFixtureServerOptionsFromEnvironment();
  const { app, fixture } = await buildControlledFixtureServer(options);
  for (const blocker of fixture.blockers) process.stdout.write(`${JSON.stringify({ type: "FIXTURE_BLOCKER", ...blocker })}\n`);
  const port = Number(requiredEnv(process.env, "PI_WEB_PORT"));
  await app.listen({ port, host: "127.0.0.1" });
}

function assertOwnedManifest(root: string, manifestFile: string): void {
  if (!isAbsolute(manifestFile)) throw new Error("manifestFile must be an absolute path");
  const rel = relative(resolve(root), resolve(manifestFile));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("manifestFile must stay under the controlled fixture root");
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`${key} is required by the controlled fixture server`);
  return value;
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
