import type { Project, SessionInfo, Workspace } from "../api";
import { traverseSessionCatalog } from "./sessionCatalogTraversal";
import type { PluginResolvedSessionLocation, PluginSessionLocationEvidence, PluginSessionLocationEvidenceRecheck, PluginSessionLocationResolution } from "./types";

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

  const traversal = await traverseSessionCatalog(input.machineId, catalog);
  const matches: { location: PluginResolvedSessionLocation; catalogCwd: string }[] = [];
  for (const scope of traversal.scopes) {
    const matchedSession = scope.sessions.find((session) => session.id === input.sessionId && session.cwd === scope.workspace.path);
    if (matchedSession === undefined) continue;
    matches.push({
      location: { machineId: input.machineId, projectId: scope.project.id, workspaceId: scope.workspace.id },
      catalogCwd: scope.workspace.path,
    });
  }

  if (traversal.failedScopes.length > 0) return { type: "unavailable", failedScopes: traversal.failedScopes };
  if (matches.length === 0) return { type: "missing" };
  const verifiedAt = catalog.now?.() ?? new Date().toISOString();
  const evidenceFor = (match: typeof matches[number]) => resolutionEvidence(input, match, traversal.scopes.length, verifiedAt);
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
