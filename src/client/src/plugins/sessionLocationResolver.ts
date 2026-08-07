import type { Project, SessionInfo, Workspace } from "../api";
import type { PluginResolvedSessionLocation, PluginSessionLocationEvidence, PluginSessionLocationEvidenceRecheck, PluginSessionLocationFailedScope, PluginSessionLocationResolution } from "./types";

export interface SessionLocationCatalog {
  isMachineRegistered(machineId: string): boolean;
  projects(machineId: string): Promise<Project[]>;
  workspaces(projectId: string, machineId: string): Promise<Workspace[]>;
  sessions(cwd: string, machineId: string): Promise<SessionInfo[]>;
  now?: () => string;
}

export async function resolveSessionLocation(
  input: { machineId: string; sessionId: string },
  catalog: SessionLocationCatalog,
): Promise<PluginSessionLocationResolution> {
  if (!catalog.isMachineRegistered(input.machineId)) {
    return { type: "unavailable", failedScopes: [{ type: "machine", machineId: input.machineId }] };
  }

  let projects: Project[];
  try {
    projects = await catalog.projects(input.machineId);
  } catch {
    return { type: "unavailable", failedScopes: [{ type: "machine", machineId: input.machineId }] };
  }

  const workspaceResults = await Promise.allSettled(
    projects.map(async (project) => ({ project, workspaces: await catalog.workspaces(project.id, input.machineId) })),
  );
  const failedScopes: PluginSessionLocationFailedScope[] = [];
  const workspaceScopes: { project: Project; workspace: Workspace }[] = [];
  workspaceResults.forEach((result, index) => {
    const project = projects[index];
    if (project === undefined) return;
    if (result.status === "rejected") {
      failedScopes.push({ type: "project", machineId: input.machineId, projectId: project.id });
      return;
    }
    for (const workspace of result.value.workspaces) workspaceScopes.push({ project, workspace });
  });

  const sessionResults = await Promise.allSettled(
    workspaceScopes.map(async (scope) => ({ ...scope, sessions: await catalog.sessions(scope.workspace.path, input.machineId) })),
  );
  const matches: { location: PluginResolvedSessionLocation; catalogCwd: string }[] = [];
  sessionResults.forEach((result, index) => {
    const scope = workspaceScopes[index];
    if (scope === undefined) return;
    if (result.status === "rejected") {
      failedScopes.push({
        type: "workspace",
        machineId: input.machineId,
        projectId: scope.project.id,
        workspaceId: scope.workspace.id,
        cwd: scope.workspace.path,
      });
      return;
    }
    const matchedSession = result.value.sessions.find((session) => session.id === input.sessionId && session.cwd === scope.workspace.path);
    if (matchedSession === undefined) return;
    matches.push({
      location: { machineId: input.machineId, projectId: scope.project.id, workspaceId: scope.workspace.id },
      catalogCwd: scope.workspace.path,
    });
  });

  if (failedScopes.length > 0) return { type: "unavailable", failedScopes };
  if (matches.length === 0) return { type: "missing" };
  const verifiedAt = catalog.now?.() ?? new Date().toISOString();
  const evidenceFor = (match: typeof matches[number]) => resolutionEvidence(input, match, workspaceScopes.length, verifiedAt);
  if (matches.length > 1) {
    return { type: "ambiguous", locations: matches.map((match) => ({ location: match.location, evidence: evidenceFor(match) })) };
  }
  const match = matches[0];
  if (match === undefined) return { type: "missing" };
  return { type: "found", location: match.location, evidence: evidenceFor(match) };
}

function resolutionEvidence(
  input: { machineId: string; sessionId: string },
  match: { location: PluginResolvedSessionLocation; catalogCwd: string },
  scannedScopeCount: number,
  verifiedAt: string,
): PluginSessionLocationEvidence {
  return {
    machineId: input.machineId,
    sessionId: input.sessionId,
    location: match.location,
    catalogCwd: match.catalogCwd,
    evidenceId: input.sessionId,
    matchedCwd: match.catalogCwd,
    scannedScopeCount,
    verifiedAt,
  };
}

export async function recheckSessionLocationEvidence(
  evidence: PluginSessionLocationEvidence,
  catalog: SessionLocationCatalog,
): Promise<PluginSessionLocationEvidenceRecheck> {
  const resolution = await resolveSessionLocation({ machineId: evidence.machineId, sessionId: evidence.sessionId }, catalog);
  const candidates = resolution.type === "found"
    ? [{ location: resolution.location, evidence: resolution.evidence }]
    : resolution.type === "ambiguous" ? resolution.locations : [];
  const confirmed = candidates.find((candidate) => sameLocation(candidate.location, evidence.location)
    && candidate.evidence.catalogCwd === evidence.catalogCwd);
  return confirmed === undefined ? { type: "stale", resolution } : { type: "confirmed", evidence: confirmed.evidence };
}

function sameLocation(left: PluginResolvedSessionLocation, right: PluginResolvedSessionLocation): boolean {
  return left.machineId === right.machineId && left.projectId === right.projectId && left.workspaceId === right.workspaceId;
}
