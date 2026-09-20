// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type SessionInfo } from "../api";
import { AllSessions } from "./AllSessions";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 2, 12));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AllSessions", () => {
  it("groups sessions by day and hides Workbench agent sessions", async () => {
    vi.spyOn(api, "recent").mockResolvedValue([
      session("today", "Today session", new Date(2026, 8, 2, 10)),
      session("yesterday", "Yesterday session", new Date(2026, 8, 1, 10)),
      session("older", "Older session", new Date(2026, 7, 20, 10)),
      session("agent", "Agent session", new Date(2026, 8, 2, 11), "workbench-reviewer-deadbeef"),
    ]);

    const element = await mount();

    expect(api.recent).toHaveBeenCalledWith(300);
    expect(headings(element)).toEqual(expect.arrayContaining(["Today", "Yesterday"]));
    expect(rowTitles(element)).toEqual(["Today session", "Yesterday session", "Older session"]);
    const toggle = element.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Show agent sessions"]');
    expect(toggle?.parentElement?.textContent).toContain("Show agent sessions (1)");

    toggle?.click();
    await element.updateComplete;
    expect(rowTitles(element)).toContain("workbench-reviewer-deadbeef");
  });

  it("searches session titles, paths, and ids case-insensitively", async () => {
    vi.spyOn(api, "recent").mockResolvedValue([
      session("alpha-id", "Release Plan", new Date(2026, 8, 2, 10), undefined, "/Users/thomas/projects/alpha"),
      session("beta-id", "Other work", new Date(2026, 8, 1, 10), undefined, "/Users/thomas/projects/beta"),
    ]);
    const element = await mount();
    const search = element.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Search sessions"]');
    if (search === undefined || search === null) throw new Error("Search input was not rendered");

    search.value = "RELEASE";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(rowTitles(element)).toEqual(["Release Plan"]);

    search.value = "beta-id";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(rowTitles(element)).toEqual(["Other work"]);
  });

  it("dispatches the selected session", async () => {
    const selected = session("selected", "Open this", new Date(2026, 8, 2, 10));
    vi.spyOn(api, "recent").mockResolvedValue([selected]);
    const element = await mount();
    let detail: SessionInfo | undefined;
    element.addEventListener("open-session", (event) => {
      const eventDetail: unknown = Reflect.get(event, "detail");
      if (isSessionInfo(eventDetail)) detail = eventDetail;
    });

    element.shadowRoot?.querySelector<HTMLButtonElement>("button.row")?.click();

    expect(detail).toEqual(selected);
  });
});

async function mount(): Promise<AllSessions> {
  const element = new AllSessions();
  document.body.append(element);
  await vi.waitFor(() => { expect(element.shadowRoot?.querySelector('[role="status"]')).toBeNull(); });
  await element.updateComplete;
  return element;
}

function headings(element: AllSessions): string[] {
  return [...(element.shadowRoot?.querySelectorAll("h2") ?? [])].map((heading) => heading.textContent);
}

function rowTitles(element: AllSessions): string[] {
  return [...(element.shadowRoot?.querySelectorAll(".row strong") ?? [])].map((title) => title.textContent);
}

function isSessionInfo(value: unknown): value is SessionInfo {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "cwd") === "string";
}

function session(id: string, firstMessage: string, modified: Date, name?: string, cwd = "/Users/thomas/projects/repo"): SessionInfo {
  return { id, cwd, path: `/sessions/${id}.jsonl`, ...(name === undefined ? {} : { name }), created: modified.toISOString(), modified: modified.toISOString(), messageCount: 3, firstMessage };
}
