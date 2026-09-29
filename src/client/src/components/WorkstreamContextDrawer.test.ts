// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { workstreamForSession, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";
import { workstreamAccentColor } from "../workstreamColor";

const snapshot: WorkstreamSnapshot = {
  id: "ws-current",
  title: "Build the Workbench launcher",
  revision: 4,
  updatedAt: "2026-09-20T18:00:00.000Z",
  closed: false,
  sessions: [{
    id: "session-current",
    status: "active",
    latestCheckpoint: {
      id: "cp-current",
      whatChanged: "The drawer prototype is ready.",
      remains: "Choose a variant.",
      next: "Thomas chooses the preferred drawer.",
      nextSessionPrompt: "Continue the drawer work.",
      recordedAt: "2026-09-20T18:00:00.000Z",
    },
  }],
  humanTasks: [],
  links: [],
  overview: {
    goal: "Restore Workstream context inside Chat.",
    doneWhen: "Thomas can identify the current Workstream without leaving Chat.",
    description: "The Workstream joins project navigation, Chat continuation, and attention state without becoming Chat state.",
    history: ["2026-09-20: prototype reviewed."],
    recordedAt: "2026-09-20T18:00:00.000Z",
  },
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("workstreamForSession", () => {
  it("locates through the session-filtered list before inspecting the one matching Workstream", async () => {
    const calls: { operation: string; input: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/plugins")) return Promise.resolve(new Response(JSON.stringify({
        lifecycleVersion: 2,
        plugins: [{ id: "pi-workbench", source: "test", scope: "user", machineSpecific: true, enabled: true, discovered: true, conflict: false, server: { state: "active", activeRevision: "revision-1", staleRevision: false, restartRequired: false, disableCommand: "pi-web plugins disable pi-workbench --restart" } }],
        diagnostics: [],
        serverRuntime: { status: "available", terminalMode: "required", restartRequired: false, recovery: { showSafeStart: "pi-web plugins safe-start show", bundledOnly: "pi-web plugins safe-start set bundled-only --restart", noServerPlugins: "pi-web plugins safe-start set none --restart", clearSafeStart: "pi-web plugins safe-start clear --restart" } },
      }), { status: 200 }));
      if (typeof init?.body !== "string") throw new Error("missing request body");
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null || !("input" in body)) throw new Error("invalid request body");
      const operation = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      calls.push({ operation, input: body.input });
      const value = operation === "list" ? [{ id: snapshot.id }] : snapshot;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), { status: 200 }));
    }));

    await expect(workstreamForSession({ machineId: "local", projectId: "project-1", workspaceId: "workspace-1" }, "session-current")).resolves.toEqual(snapshot);
    expect(calls).toEqual([
      { operation: "list", input: { sessionId: "session-current", includeClosed: true } },
      { operation: "inspect", input: { workstreamId: "ws-current" } },
    ]);
  });
});

describe("WorkstreamContextDrawer", () => {
  const context = { machineId: "local", projectId: "project-1", workspaceId: "workspace-1" };
  function required<T extends Node>(value: T | null): T {
    if (value === null) throw new Error("Missing editor control");
    return value;
  }
  async function editor(fetcher: (operation: string, input: unknown) => unknown, initial: WorkstreamSnapshot = snapshot): Promise<WorkstreamContextDrawer> {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/plugins")) return Promise.resolve(new Response(JSON.stringify({ lifecycleVersion: 2, plugins: [{ id: "pi-workbench", source: "test", scope: "user", machineSpecific: true, enabled: true, discovered: true, conflict: false, server: { state: "active", activeRevision: "revision-1", staleRevision: false, restartRequired: false, disableCommand: "pi-web plugins disable pi-workbench --restart" } }], diagnostics: [], serverRuntime: { status: "available", terminalMode: "required", restartRequired: false, recovery: { showSafeStart: "pi-web plugins safe-start show", bundledOnly: "pi-web plugins safe-start set bundled-only --restart", noServerPlugins: "pi-web plugins safe-start set none --restart", clearSafeStart: "pi-web plugins safe-start clear --restart" } } }), { status: 200 }));
      const operation = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      if (typeof init?.body !== "string") throw new Error("Missing request body");
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null || !("input" in body)) throw new Error("Invalid request body");
      const result = fetcher(operation, body.input);
      return Promise.resolve(result instanceof Response ? result : new Response(JSON.stringify({ ok: true, value: result }), { status: 200 }));
    }));
    const element = new WorkstreamContextDrawer();
    element.snapshot = structuredClone(initial);
    element.serviceContext = context;
    element.sessionId = "session-current";
    document.body.append(element);
    await element.updateComplete;
    element.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
    await element.updateComplete;
    return element;
  }

  it("prefills, validates, cancels with discard confirmation, and saves owner records once", async () => {
    const calls: unknown[] = [];
    const element = await editor((operation, input) => {
      if (operation === "inspect") return snapshot;
      calls.push(input);
      return { acceptedRevision: 5 };
    });
    const root = required(element.shadowRoot);
    expect(root.querySelector<HTMLInputElement>("#workstream-title")?.value).toBe(snapshot.title);
    expect(root.querySelector<HTMLTextAreaElement>("#whatChanged")?.value).toBe(snapshot.sessions[0]?.latestCheckpoint?.whatChanged);
    const title = required(root.querySelector<HTMLInputElement>("#workstream-title"));
    title.value = " "; title.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(root.querySelector("#title-error")?.textContent).toContain("Enter a title");
    title.value = "New title"; title.dispatchEvent(new Event("input", { bubbles: true }));
    const next = required(root.querySelector<HTMLTextAreaElement>("#next"));
    next.value = "Owner's next step"; next.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    vi.stubGlobal("confirm", vi.fn(() => false));
    root.querySelector<HTMLButtonElement>('button[type="button"]:last-child')?.click();
    await element.updateComplete;
    expect(root.querySelector("form")).not.toBeNull();
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    const request: unknown = calls[0];
    expect(request).toMatchObject({ expectedRevision: 4, records: [
      { type: "title.set", producer: "owner", payload: { title: "New title" } },
      { type: "checkpoint.replaced", producer: "owner", payload: { sessionId: "session-current", checkpoint: { next: "Owner's next step" } } },
    ] });
    expect(request).toHaveProperty("idempotencyKey", expect.any(String));
    expect(request).toHaveProperty("records.1.sourceSessionId", "session-current");
    expect(request).not.toHaveProperty("records.1.payload.checkpoint.nextSessionPrompt");
    expect(request).not.toHaveProperty("records.1.payload.checkpoint.waitingOn");
  });

  it("saves waitingOn alone without a prompt field, prefilled from the checkpoint", async () => {
    const current = snapshot.sessions[0]?.latestCheckpoint;
    if (current === undefined || current === null) throw new Error("Missing fixture checkpoint");
    const promptless = { ...snapshot, sessions: [{ id: "session-current", status: "active", latestCheckpoint: { ...current, nextSessionPrompt: null, waitingOn: "agent" as const, references: ["/repo/drawer"] } }] };
    const calls: unknown[] = [];
    const element = await editor((operation, input) => { if (operation === "inspect") return promptless; calls.push(input); return { acceptedRevision: 5 }; }, promptless);
    const root = required(element.shadowRoot);
    expect(root.querySelector("#nextSessionPrompt")).toBeNull();
    expect(root.textContent).not.toContain("Next session prompt");
    const waiting = required(root.querySelector<HTMLSelectElement>("#waitingOn"));
    expect(waiting.value).toBe("agent");
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    waiting.value = "owner"; waiting.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    expect(calls[0]).toMatchObject({ records: [{ type: "checkpoint.replaced", payload: { checkpoint: {
      whatChanged: current.whatChanged, remains: current.remains, next: current.next, waitingOn: "owner", references: ["/repo/drawer"],
    } } }] });
    expect(calls[0]).not.toHaveProperty("records.0.payload.checkpoint.nextSessionPrompt");
  });

  it("retries an uncertain save with the same operation and checkpoint id", async () => {
    const calls: unknown[] = [];
    let failed = false;
    const element = await editor((operation, input) => {
      if (operation === "inspect") return snapshot;
      calls.push(input);
      if (!failed) { failed = true; throw new Error("connection lost"); }
      return { acceptedRevision: 5 };
    });
    const root = required(element.shadowRoot);
    const title = required(root.querySelector<HTMLInputElement>("#workstream-title"));
    title.value = "Retry title"; title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(root.textContent).toContain("Retry the same update"); });
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(calls).toHaveLength(2); });
    expect(calls[1]).toEqual(calls[0]);
  });

  it("unlocks the draft after a coded store failure without reusing the failed operation", async () => {
    const calls: unknown[] = [];
    const element = await editor((operation, input) => {
      if (operation === "inspect") return snapshot;
      calls.push(input);
      return new Response(JSON.stringify({ ok: false, error: { code: "INVALID_REQUEST", message: "invalid fields", details: { field: "title" } } }), { status: 200 });
    });
    const root = required(element.shadowRoot);
    const title = required(root.querySelector<HTMLInputElement>("#workstream-title"));
    title.value = "Local"; title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(root.textContent).toContain("Could not save Workstream. Error: invalid fields"); });
    expect(root.querySelector<HTMLInputElement>("#workstream-title")?.disabled).toBe(false);
    expect(root.querySelector<HTMLInputElement>("#workstream-title")?.value).toBe("Local");
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(calls).toHaveLength(2); });
    expect(calls[1]).not.toEqual(calls[0]);
  });

  it("treats a coded append conflict as a conflict even without revision text", async () => {
    const element = await editor((operation) => operation === "inspect" ? snapshot
      : new Response(JSON.stringify({ ok: false, error: { code: "STALE_REVISION", message: "concurrent edit", details: { currentRevision: 5 } } }), { status: 200 }));
    const root = required(element.shadowRoot);
    const title = required(root.querySelector<HTMLInputElement>("#workstream-title"));
    title.value = "Local"; title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(root.textContent).toContain("changed elsewhere"); });
    expect(title.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it("edits and replaces only the selected session's checkpoint", async () => {
    const currentCheckpoint = snapshot.sessions[0]?.latestCheckpoint;
    if (currentCheckpoint === undefined || currentCheckpoint === null) throw new Error("Missing fixture checkpoint");
    const older = { ...snapshot, sessions: [
      { id: "other", status: "active", latestCheckpoint: { ...currentCheckpoint, id: "other-cp", next: "Other session", recordedAt: "2026-09-21T18:00:00.000Z" } },
      ...snapshot.sessions,
    ] };
    const calls: unknown[] = [];
    const element = await editor((operation, input) => { if (operation === "inspect") return older; calls.push(input); return { acceptedRevision: 5 }; }, older);
    const root = required(element.shadowRoot);
    expect(root.querySelector<HTMLTextAreaElement>("#next")?.value).toBe("Thomas chooses the preferred drawer.");
    expect(root.textContent).toContain("Checkpoint for Chat session-current");
    const next = required(root.querySelector<HTMLTextAreaElement>("#next"));
    next.value = "Selected next"; next.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    expect(calls[0]).toMatchObject({ records: [{ type: "checkpoint.replaced", sourceSessionId: "session-current", payload: { sessionId: "session-current", checkpoint: { next: "Selected next" } } }] });
  });

  it("saves title alone when there is no checkpoint, and refreshes the visible title", async () => {
    const empty = { ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session, latestCheckpoint: null })) };
    const calls: unknown[] = [];
    let saved = false;
    const element = await editor((operation, input) => {
      if (operation === "inspect") return saved ? { ...empty, title: "Renamed", revision: 5 } : empty;
      calls.push(input); saved = true; return { acceptedRevision: 5 };
    }, empty);
    const root = required(element.shadowRoot);
    const title = required(root.querySelector<HTMLInputElement>("#workstream-title"));
    title.value = "Renamed"; title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(root.querySelector("summary strong")?.textContent).toBe("Renamed"); });
    expect(calls[0]).toMatchObject({ records: [{ type: "title.set", producer: "owner" }] });
    expect(root.querySelector("form")).toBeNull();
  });

  it("preserves the draft on stale revision and reloads current state without appending", async () => {
    const calls: string[] = [];
    const element = await editor((operation) => { calls.push(operation); return { ...snapshot, revision: 5, title: "Elsewhere" }; });
    const root = required(element.shadowRoot);
    const title = required(root.querySelector<HTMLInputElement>("#workstream-title"));
    title.value = "Local"; title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() => { expect(root.textContent).toContain("changed elsewhere"); });
    expect(title.value).toBe("Local");
    expect(calls).toEqual(["inspect"]);
    root.querySelector<HTMLButtonElement>("form button:not([type=submit]):not(:last-child)")?.click();
    await vi.waitFor(() => { expect(root.textContent).toContain("local draft is kept"); });
    expect(root.querySelector<HTMLInputElement>("#workstream-title")?.value).toBe("Local");
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("uses the selected pull-down design and reveals the actual overview language", async () => {
    const element = new WorkstreamContextDrawer();
    element.fallbackTitle = "Unassociated Chat";
    element.sessionId = "session-current";
    element.snapshot = snapshot;
    document.body.append(element);
    await element.updateComplete;

    const root = element.shadowRoot;
    const details = root?.querySelector("details");
    const summary = details?.querySelector("summary");
    expect(summary?.querySelector(".visually-hidden")?.textContent).toBe("Workstream: ");
    expect(summary?.querySelector(".identity-mark, .context-label")).toBeNull();
    expect(summary?.textContent).toBe("Workstream: Build the Workbench launcher");
    expect(summary?.querySelector("strong")?.textContent).toBe("Build the Workbench launcher");
    expect(root?.textContent).not.toContain("Unassociated Chat");
    expect(details?.open).toBe(false);
    summary?.focus();
    expect(root?.activeElement).toBe(summary);
    expect(WorkstreamContextDrawer.styles.cssText).toMatch(/summary:focus-visible\s*\{[^}]*outline:/);
    expect(WorkstreamContextDrawer.styles.cssText).toMatch(/@media \(forced-colors: active\)[\s\S]*summary\s*\{[^}]*border-left-color: LinkText/);
    summary?.click();
    expect(details?.open).toBe(true);
    expect(root?.textContent).toContain("Restore Workstream context inside Chat.");
    expect(root?.textContent).toContain("Done when");
    expect(root?.textContent).toContain("The Workstream joins project navigation");
    expect(root?.textContent).toContain("Thomas chooses the preferred drawer.");
    expect(root?.querySelectorAll(".row > .label")).toHaveLength(4);
    expect(root?.querySelector(".next > .label")?.textContent).toBe("Do next");
    expect(details?.style.getPropertyValue("--workstream-color")).toBe(workstreamAccentColor(snapshot.id));
    summary?.click();
    expect(details?.open).toBe(false);
  });

  it("shows the Chat title in the existing status tab when no Workstream is associated", async () => {
    const element = new WorkstreamContextDrawer();
    element.fallbackTitle = "Named Chat";
    element.snapshot = null;
    document.body.append(element);
    await element.updateComplete;

    const tab = element.shadowRoot?.querySelector<HTMLElement>(".tab");
    const title = tab?.querySelector<HTMLElement>(".fallback-title");
    expect(title?.textContent).toBe("Named Chat");
    expect(tab?.title).toBe("Named Chat");
    expect(tab?.getAttribute("role")).toBeNull();
    expect(getComputedStyle(title ?? document.body).flexGrow).toBe("1");
    expect(getComputedStyle(title ?? document.body).minWidth).toBe("0");
    expect(getComputedStyle(title ?? document.body).overflow).toBe("hidden");
    expect(getComputedStyle(title ?? document.body).textOverflow).toBe("ellipsis");
    expect(element.shadowRoot?.querySelector("details")).toBeNull();
  });

  it("keeps loading and error states ahead of the fallback title", async () => {
    const element = new WorkstreamContextDrawer();
    element.fallbackTitle = "Named Chat";
    document.body.append(element);
    await element.updateComplete;

    let tab = element.shadowRoot?.querySelector<HTMLElement>(".tab");
    expect(tab?.textContent).toBe("Named Chat");
    expect(tab?.getAttribute("role")).toBe("status");

    element.error = "Workbench bridge unavailable";
    await element.updateComplete;
    tab = element.shadowRoot?.querySelector<HTMLElement>(".tab");
    expect(tab?.textContent).toBe("Named Chat");
    expect(tab?.title).toBe("Workbench bridge unavailable");
    expect(tab?.getAttribute("role")).toBe("status");
  });
});
