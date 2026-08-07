import type { Project, SessionInfo, Workspace } from "../api";
import { shortSessionId } from "../sessionLabels";
import { traverseSessionCatalog } from "./sessionCatalogTraversal";
import type { PluginMachine, SessionNavigationFailedScope, SessionNavigationHost, SessionNavigationItem, SessionNavigationLocation, SessionNavigationSnapshot } from "./types";

const CATALOG_CONCURRENCY = 4;

export interface SessionNavigationCatalog {
  projects(machineId: string, signal: AbortSignal): Promise<Project[]>;
  workspaces(projectId: string, machineId: string, signal: AbortSignal): Promise<Workspace[]>;
  sessions(cwd: string, machineId: string, signal: AbortSignal): Promise<SessionInfo[]>;
}

export interface SessionNavigationScope {
  machine: PluginMachine;
  connected: boolean;
  selectedIdentity?: string;
}

export interface SessionNavigationControllerDependencies {
  catalog: SessionNavigationCatalog;
  select(location: SessionNavigationLocation): Promise<void>;
  concurrency?: number;
}

interface CatalogLoadResult {
  sessions: readonly SessionNavigationItem[];
  failedScopes: readonly SessionNavigationFailedScope[];
}

/** Owns the selected-machine catalog lifecycle; plugins only receive the immutable host below. */
export class SessionNavigationController {
  private readonly watchers = new Set<(snapshot: SessionNavigationSnapshot) => void>();
  private readonly completeByMachine = new Map<string, readonly SessionNavigationItem[]>();
  private readonly concurrency: number;
  private snapshotValue: SessionNavigationSnapshot;
  private refreshController: AbortController | undefined;
  private refreshSequence = 0;
  private refreshDirty = false;
  private selectionTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly dependencies: SessionNavigationControllerDependencies, private scope: SessionNavigationScope) {
    this.concurrency = Math.max(1, Math.floor(dependencies.concurrency ?? CATALOG_CONCURRENCY));
    this.snapshotValue = freezeSnapshot({
      sequence: 0,
      machine: scope.machine,
      selectedIdentity: scope.selectedIdentity,
      loading: scope.connected,
      reconnectComplete: false,
      failedScopes: scope.connected ? [] : [{ type: "machine", machineId: scope.machine.id }],
      sessions: [],
    });
  }

  readonly host: SessionNavigationHost = {
    snapshot: () => this.snapshotValue,
    watch: (handler) => this.watch(handler),
    refresh: () => { this.invalidate(); },
    select: (location) => this.sequenceSelection(location),
  };

  sync(scope: SessionNavigationScope): void {
    if (this.disposed) return;
    const machineChanged = scope.machine.id !== this.scope.machine.id;
    const connectionChanged = scope.connected !== this.scope.connected;
    const selectionChanged = scope.selectedIdentity !== this.scope.selectedIdentity;
    this.scope = scope;

    if (machineChanged) {
      this.cancelRefresh();
      this.publish({
        machine: scope.machine,
        selectedIdentity: scope.selectedIdentity,
        loading: scope.connected && this.watchers.size > 0,
        reconnectComplete: false,
        failedScopes: scope.connected ? [] : [{ type: "machine", machineId: scope.machine.id }],
        sessions: this.completeByMachine.get(scope.machine.id) ?? [],
      });
      this.refreshIfObserved();
      return;
    }

    if (connectionChanged) {
      if (!scope.connected) this.cancelRefresh();
      this.publish({
        machine: scope.machine,
        selectedIdentity: scope.selectedIdentity,
        loading: scope.connected && this.watchers.size > 0,
        reconnectComplete: false,
        failedScopes: scope.connected ? [] : [{ type: "machine", machineId: scope.machine.id }],
        sessions: this.snapshotValue.sessions,
      });
      this.refreshIfObserved();
      return;
    }

    if (selectionChanged || !sameMachine(scope.machine, this.snapshotValue.machine)) {
      this.publish({
        machine: scope.machine,
        selectedIdentity: scope.selectedIdentity,
        loading: this.snapshotValue.loading,
        reconnectComplete: this.snapshotValue.reconnectComplete,
        failedScopes: this.snapshotValue.failedScopes,
        sessions: this.snapshotValue.sessions,
      });
    }
  }

  invalidate(): void {
    if (this.disposed || !this.scope.connected) return;
    if (this.refreshController !== undefined) {
      this.refreshDirty = true;
      return;
    }
    this.beginRefresh();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRefresh();
    this.watchers.clear();
  }

  private watch(handler: (snapshot: SessionNavigationSnapshot) => void): () => void {
    if (this.disposed) {
      handler(this.snapshotValue);
      return () => undefined;
    }
    this.watchers.add(handler);
    handler(this.snapshotValue);
    this.refreshIfObserved();
    return () => {
      this.watchers.delete(handler);
      if (this.watchers.size === 0) {
        this.cancelRefresh();
        if (this.snapshotValue.loading) {
          this.publish({
            machine: this.scope.machine,
            selectedIdentity: this.scope.selectedIdentity,
            loading: false,
            reconnectComplete: this.snapshotValue.reconnectComplete,
            failedScopes: this.snapshotValue.failedScopes,
            sessions: this.snapshotValue.sessions,
          });
        }
      }
    };
  }

  private refreshIfObserved(): void {
    if (this.watchers.size === 0 || !this.scope.connected || this.refreshController !== undefined) return;
    this.beginRefresh();
  }

  private beginRefresh(): void {
    if (this.watchers.size === 0 || !this.scope.connected || this.refreshController !== undefined) return;
    const controller = new AbortController();
    const refreshSequence = ++this.refreshSequence;
    const machine = this.scope.machine;
    this.refreshController = controller;
    this.publish({
      machine,
      selectedIdentity: this.scope.selectedIdentity,
      loading: true,
      reconnectComplete: this.snapshotValue.reconnectComplete,
      failedScopes: this.snapshotValue.failedScopes,
      sessions: this.snapshotValue.sessions,
    });
    void loadSessionNavigationCatalog(machine, this.dependencies.catalog, controller.signal, this.concurrency)
      .then((result) => {
        if (!this.isCurrentRefresh(refreshSequence, machine.id, controller)) return;
        this.refreshController = undefined;
        if (this.refreshDirty) {
          this.refreshDirty = false;
          this.beginRefresh();
          return;
        }
        const complete = result.failedScopes.length === 0;
        if (complete) this.completeByMachine.set(machine.id, result.sessions);
        this.publish({
          machine,
          selectedIdentity: this.scope.selectedIdentity,
          loading: false,
          reconnectComplete: complete,
          failedScopes: result.failedScopes,
          sessions: complete || !this.completeByMachine.has(machine.id)
            ? result.sessions
            : retainSafePriorSessions(this.completeByMachine.get(machine.id) ?? [], result.failedScopes),
        });
      })
      .catch((error: unknown) => {
        if (!this.isCurrentRefresh(refreshSequence, machine.id, controller)) return;
        this.refreshController = undefined;
        if (isAbortError(error)) return;
        if (this.refreshDirty) {
          this.refreshDirty = false;
          this.beginRefresh();
          return;
        }
        this.publish({
          machine,
          selectedIdentity: this.scope.selectedIdentity,
          loading: false,
          reconnectComplete: false,
          failedScopes: [{ type: "machine", machineId: machine.id }],
          sessions: this.completeByMachine.get(machine.id) ?? [],
        });
      });
  }

  private sequenceSelection(location: SessionNavigationLocation): Promise<void> {
    const run = () => this.dependencies.select(location);
    const selection = this.selectionTail.then(run, run);
    this.selectionTail = selection.catch(() => undefined);
    return selection;
  }

  private isCurrentRefresh(sequence: number, machineId: string, controller: AbortController): boolean {
    return !this.disposed
      && this.refreshSequence === sequence
      && this.refreshController === controller
      && this.scope.machine.id === machineId
      && this.scope.connected
      && !controller.signal.aborted;
  }

  private cancelRefresh(): void {
    this.refreshSequence += 1;
    this.refreshDirty = false;
    this.refreshController?.abort();
    this.refreshController = undefined;
  }

  private publish(value: Omit<SessionNavigationSnapshot, "sequence">): void {
    this.snapshotValue = freezeSnapshot({ ...value, sequence: this.snapshotValue.sequence + 1 });
    for (const watcher of this.watchers) watcher(this.snapshotValue);
  }
}

export function sessionNavigationIdentity(location: SessionNavigationLocation): string {
  return JSON.stringify([location.machineId, location.projectId, location.workspaceId, location.sessionId]);
}

async function loadSessionNavigationCatalog(
  machine: PluginMachine,
  catalog: SessionNavigationCatalog,
  signal: AbortSignal,
  concurrency: number,
): Promise<CatalogLoadResult> {
  const traversal = await traverseSessionCatalog(machine.id, catalog, { signal, concurrency });
  const candidates = new Map<string, SessionNavigationItem[]>();
  for (const { project, workspace, sessions } of traversal.scopes) {
    for (const session of sessions) {
      if (session.cwd !== workspace.path) continue;
      const location: SessionNavigationLocation = {
        machineId: machine.id,
        projectId: project.id,
        workspaceId: workspace.id,
        sessionId: session.id,
      };
      const identity = sessionNavigationIdentity(location);
      const name = session.name?.trim();
      const title = name !== undefined && name !== "" ? name : session.firstMessage !== "" ? session.firstMessage : shortSessionId(session.id);
      const item: SessionNavigationItem = {
        identity,
        sessionId: session.id,
        title,
        summary: session.firstMessage,
        status: session.archived === true ? "archived" : "current",
        modifiedAt: session.modified,
        location,
      };
      const homes = candidates.get(session.id) ?? [];
      homes.push(item);
      candidates.set(session.id, homes);
    }
  }

  const failedScopes: SessionNavigationFailedScope[] = [...traversal.failedScopes];
  const items: SessionNavigationItem[] = [];
  for (const [sessionId, homes] of candidates) {
    if (homes.length > 1) {
      failedScopes.push({ type: "session", machineId: machine.id, sessionId, locations: homes.map((item) => item.location) });
    } else {
      const item = homes[0];
      if (item !== undefined) items.push(item);
    }
  }
  return {
    sessions: Object.freeze(items
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.identity.localeCompare(right.identity))
      .map((item) => freezeItem(item))),
    failedScopes: Object.freeze(failedScopes.map((scope) => freezeFailedScope(scope))),
  };
}

function retainSafePriorSessions(
  sessions: readonly SessionNavigationItem[],
  failedScopes: readonly SessionNavigationFailedScope[],
): readonly SessionNavigationItem[] {
  const duplicateSessionIds = new Set(failedScopes.flatMap((scope) => scope.type === "session" ? [scope.sessionId] : []));
  return duplicateSessionIds.size === 0 ? sessions : sessions.filter((session) => !duplicateSessionIds.has(session.sessionId));
}

function freezeSnapshot(snapshot: SessionNavigationSnapshot): SessionNavigationSnapshot {
  const machine = Object.freeze({ ...snapshot.machine });
  const sessions = Object.freeze(snapshot.sessions.map((item) => freezeItem(item)));
  const failedScopes = Object.freeze(snapshot.failedScopes.map((scope) => freezeFailedScope(scope)));
  return Object.freeze({ ...snapshot, machine, sessions, failedScopes });
}

function freezeItem(item: SessionNavigationItem): SessionNavigationItem {
  return Object.freeze({ ...item, location: Object.freeze({ ...item.location }) });
}

function freezeFailedScope(scope: SessionNavigationFailedScope): SessionNavigationFailedScope {
  if (scope.type !== "session") return Object.freeze({ ...scope });
  return Object.freeze({ ...scope, locations: Object.freeze(scope.locations.map((location) => Object.freeze({ ...location }))) });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function sameMachine(left: PluginMachine, right: PluginMachine): boolean {
  return left.id === right.id && left.name === right.name && left.kind === right.kind;
}
