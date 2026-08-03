// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, WorkspaceActivity } from "../api";
import { ProjectList } from "./ProjectList";

afterEach(() => {
  document.body.replaceChildren();
});

describe("project actions", () => {
  it("adds projects from the Projects heading", async () => {
    const list = await mountProjectList([], new Set());
    const onAdd = vi.fn();
    list.onAdd = onAdd;
    await list.updateComplete;

    const addButton = list.shadowRoot?.querySelector<HTMLButtonElement>(".add-project");
    expect(addButton?.getAttribute("aria-label")).toBe("Add project");
    addButton?.click();

    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("offers to change a moved project's location", async () => {
    const movedProject = project("project-a");
    const list = await mountProjectList([movedProject], new Set());
    const onRelocate = vi.fn();
    list.onRelocate = onRelocate;
    await list.updateComplete;

    const menuToggle = list.shadowRoot?.querySelector<HTMLButtonElement>(".action-menu-toggle");
    menuToggle?.click();
    await list.updateComplete;
    const relocate = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-panel button") ?? [])]
      .find((button) => button.textContent.trim() === "Change location…");

    expect(relocate).toBeDefined();
    relocate?.click();
    expect(onRelocate).toHaveBeenCalledWith(movedProject);
  });
});

describe("project unread indicator", () => {
  it("shows an unread dot only on projects tracked as unread", async () => {
    const list = await mountProjectList([project("project-a"), project("project-b")], new Set(["project-b"]));

    expect(unreadDot(rowFor(list, "project-a"))).toBeNull();
    const dot = unreadDot(rowFor(list, "project-b"));
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("Unread sessions in this project");
  });

  it("clears the dot once the project is no longer tracked as unread", async () => {
    const list = await mountProjectList([project("project-a")], new Set(["project-a"]));
    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).not.toBeNull();

    list.unreadProjectIds = new Set();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("wraps the work dot in an unread ring when the project is busy and unread", async () => {
    const list = await mountProjectList([project("project-a")], new Set(["project-a"]));
    list.activities = { "/repo/project-a": workspaceActivity("/repo/project-a", true, false) };
    await list.updateComplete;

    const row = rowFor(list, "project-a");
    const ring = row.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions in this project · Project active");
    expect(row.querySelector(".activity-indicator.unread")).toBeNull();
  });
});

async function mountProjectList(projects: Project[], unreadProjectIds: ReadonlySet<string>): Promise<ProjectList> {
  const list = new ProjectList();
  list.projects = projects;
  list.unreadProjectIds = unreadProjectIds;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function rowFor(list: ProjectList, projectName: string): Element {
  const rows = [...(list.shadowRoot?.querySelectorAll(".action-row") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(projectName));
  if (row === undefined) throw new Error(`Expected a project row for ${projectName}`);
  return row;
}

function unreadDot(row: Element): Element | null {
  return row.querySelector(".activity-indicator.unread");
}

function workspaceActivity(cwd: string, hasSessionActivity: boolean, hasTerminalActivity: boolean): WorkspaceActivity {
  return { cwd, hasSessionActivity, hasTerminalActivity, updatedAt: "2026-06-04T00:00:00.000Z" };
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}
