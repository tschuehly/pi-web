import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_NOTES_BODY, E2E_PLAN, E2E_REPORT_BODY, E2E_SEARCH_MATCHES, E2E_SIBLING_BODY } from "./isolatedPiWeb";

// Set PI_WEB_E2E_SCREENSHOTS to a folder to keep review screenshots of the Files pane.
const SHOTS = process.env["PI_WEB_E2E_SCREENSHOTS"];

async function openChat(page: Page): Promise<void> {
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.goto(url);
  await expect(page.getByRole("link", { name: "the notes" })).toBeVisible();
}

function projectFile(path: string): string {
  const root = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (root === undefined) throw new Error("Isolated PI WEB was not started");
  return join(root, path);
}

async function shot(target: Page | Locator, name: string): Promise<void> {
  if (SHOTS !== undefined) await target.screenshot({ path: join(SHOTS, name) });
}

/** Opens `docs/<name>` through the Files tree. */
async function openFromTree(page: Page, name: string): Promise<Locator> {
  await page.getByRole("button", { name: "Search files" }).click();
  const pane = page.locator("workbench-files-pane");
  const docs = pane.locator(".tree .row.dir", { hasText: "docs" });
  if (await docs.getAttribute("aria-expanded") !== "true") await docs.click();
  await pane.locator(`.tree .row.file[data-path="docs/${name}"]`).click();
  await expect(pane.locator(".crumbs")).toHaveAttribute("title", `docs/${name}`);
  return pane;
}

test("the file tree filter searches the workspace and loads the next page", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Search files" }).click();
  const pane = page.locator("workbench-files-pane");
  await expect(pane.getByRole("textbox", { name: "Filter files" })).toBeFocused();
  await pane.getByRole("textbox", { name: "Filter files" }).fill("entry-");
  const results = pane.locator(".tree .row.file");
  await expect(results).toHaveCount(100);
  await expect(pane.locator(".tree .row.dir", { hasText: "entries" })).toBeVisible();
  await expect(pane.getByText("Search failed")).toHaveCount(0);
  await pane.getByRole("button", { name: "Load more" }).click();
  await expect(results).toHaveCount(E2E_SEARCH_MATCHES);
  await pane.getByRole("textbox", { name: "Filter files" }).press("Enter");
  await expect(pane.locator(".crumbs")).toHaveAttribute("title", "entries/entry-000.txt");
});

test("Markdown opens Live from the tree, toggles Raw, saves with ⌘S, and shows agent edits inline", async ({ page }) => {
  const path = projectFile("docs/plan.md");
  await openChat(page);
  const pane = await openFromTree(page, "plan.md");
  await expect(pane.locator(".tree-open")).toHaveCount(0);
  // Live preview: rendered table, checkboxes, hidden heading marks; the drawer is clipped to the pane.
  await expect(pane.locator(".cm-content.lp-on")).toBeVisible();
  await expect(pane.locator(".lp-check")).toHaveCount(2);
  const table = await pane.locator(".lp-table").boundingBox();
  const content = await pane.locator(".cm-content").boundingBox();
  expect(table !== null && content !== null && table.x + table.width <= content.x + content.width + 1).toBe(true);
  expect(await pane.locator(".body").evaluate((body) => getComputedStyle(body).overflow)).toBe("hidden");
  await shot(page, "a-markdown-live.png");
  await pane.getByRole("button", { name: "Files", exact: true }).click();
  await expect(pane.locator(".tree .row.sel")).toHaveAttribute("data-path", "docs/plan.md");
  await shot(page, "b-tree-drawer.png");
  await page.keyboard.press("Escape");
  await expect(pane.locator(".tree-open")).toHaveCount(0);

  await pane.getByRole("button", { name: "Raw" }).click();
  await expect(pane.locator(".cm-content.lp-on")).toHaveCount(0);
  await expect(pane.getByText("# Release plan")).toBeVisible();
  await pane.getByRole("button", { name: "Live" }).click();
  await expect(pane.locator(".cm-content.lp-on")).toBeVisible();

  // The line wraps in the narrow pane; click right of its last visual line to reach its end.
  const risk = pane.locator(".cm-line", { hasText: "Network flakiness" });
  const box = await risk.boundingBox();
  await risk.click({ position: { x: (box?.width ?? 10) - 4, y: (box?.height ?? 10) - 6 } });
  await page.keyboard.type(" Added by the user.");
  await expect(pane.locator(".state")).toHaveText("Unsaved · ⌘S");
  await page.keyboard.press("Meta+s");
  await expect(pane.locator(".state")).toHaveText(/Saved/);
  expect(await readFile(path, "utf8")).toContain("by a day or two. Added by the user.");

  // The agent changes one word and rewrites one sentence on disk.
  const disk = await readFile(path, "utf8");
  await writeFile(path, disk.replace("Friday", "Monday").replace("Network flakiness could delay the rollout by a day or two. Added by the user.", "Vendor approval is still pending.\nEscalate it on Tuesday."));
  await expect(pane.locator(".hunk-del")).toHaveText("Friday", { timeout: 8000 });
  await expect(pane.locator(".hunk-ins")).toHaveText("Monday");
  await expect(pane.locator(".hunk-old")).toContainText("Network flakiness");
  await expect(pane.locator(".strip")).toContainText("2 agent changes");
  await shot(page, "c-agent-hunks.png");
  await pane.locator(".hunk-inline-btns .reject").click();
  await expect(pane.locator(".hunk-del")).toHaveCount(0);
  await expect(pane.getByText("The launch is on Friday.")).toBeVisible();
  await expect(pane.locator(".strip")).toContainText("1 agent change");

  await pane.getByRole("button", { name: "Open full size" }).click();
  await expect(pane.locator(".pane.full")).toBeVisible();
  // Lifted over the whole window, with the Markdown column centered at reading width.
  const viewport = page.viewportSize();
  const full = await pane.locator(".pane.full").boundingBox();
  expect(viewport !== null && full !== null && full.width > viewport.width - 80 && full.height > viewport.height - 80).toBe(true);
  expect((await pane.locator(".cm-content").boundingBox())?.width).toBeLessThanOrEqual(880);
  await shot(page, "d-full-size.png");
  await page.keyboard.press("Escape");
  await expect(pane.locator(".pane.full")).toHaveCount(0);

  await pane.getByText("The launch is on").click();
  await page.keyboard.press("Meta+s");
  await expect(pane.locator(".strip")).toHaveCount(0);
  await expect.poll(() => readFile(path, "utf8")).toContain("The launch is on Friday.");
  expect(await readFile(path, "utf8")).toContain("Escalate it on Tuesday.");
});

test("a save after an unseen agent edit shows the agent's changes for review first", async ({ page }) => {
  const path = projectFile("docs/conflict.md");
  await openChat(page);
  const pane = await openFromTree(page, "conflict.md");
  // Pause the 2s disk poll so the save itself meets the agent's edit.
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); });
  await pane.getByText("The launch is on").click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type(" Confirmed.");
  await writeFile(path, E2E_PLAN.replace("## Risks", "## Risks and mitigations"));
  await page.keyboard.press("Meta+s");
  await expect(pane.locator(".state")).toHaveText("Agent changed the file first · review, then ⌘S");
  await expect(pane.locator(".hunk-ins")).toHaveText("and mitigations");
  expect(await readFile(path, "utf8")).not.toContain("Confirmed.");
  await page.keyboard.press("Meta+s");
  await expect(pane.locator(".state")).toHaveText(/Saved/);
  const saved = await readFile(path, "utf8");
  expect(saved).toContain("The launch is on Friday. Confirmed.");
  expect(saved).toContain("## Risks and mitigations");
});

test("a Chat file link with #L40-L42 opens the file and highlights those lines", async ({ page }) => {
  await openChat(page);
  await page.getByRole("link", { name: "the lines" }).click();
  const pane = page.locator("workbench-files-pane");
  await expect(pane.locator(".crumbs")).toHaveAttribute("title", "docs/long.md");
  await expect(pane.locator(".cm-range")).toHaveCount(3);
  await expect(pane.locator(".cm-range").first()).toHaveText("Line 40 of the long file.");
  await expect(pane.locator(".cm-range").first()).toBeInViewport();
  await pane.getByText("Line 44 of the long file.").click();
  await expect(pane.locator(".cm-range")).toHaveCount(0);
});

test("a Markdown file link in Chat opens that file in the Files pane", async ({ page }) => {
  await openChat(page);
  await page.getByRole("link", { name: "the notes" }).click();
  const pane = page.locator("workbench-files-pane");
  await expect(pane.locator(".crumbs")).toHaveAttribute("title", "docs/notes.md");
  await expect(pane.getByText(E2E_NOTES_BODY)).toBeVisible();
  expect(page.url()).toBe(process.env["PI_WEB_E2E_CHAT_URL"]);
});

test("a file link in a Chat outside every registered project opens in the Files pane", async ({ page }) => {
  const url = process.env["PI_WEB_E2E_ADHOC_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.goto(url);
  await page.getByRole("link", { name: "the report" }).click();
  const pane = page.locator("workbench-files-pane");
  await expect(pane.locator(".crumbs")).toHaveAttribute("title", "report.md");
  await expect(pane.getByText(E2E_REPORT_BODY)).toBeVisible();
  await expect(pane.getByText("registered workspaces")).toHaveCount(0);
  expect(page.url()).toBe(url);
});

test("a ../sibling file link in Chat opens that file, editable, in the Files pane", async ({ page }) => {
  const file = process.env["PI_WEB_E2E_SIBLING_FILE"];
  if (file === undefined) throw new Error("Isolated PI WEB was not started");
  await openChat(page);
  await page.getByRole("link", { name: "the sibling file" }).click();
  const pane = page.locator("workbench-files-pane");
  await expect(pane.locator(".crumbs")).toHaveAttribute("title", "generator.ts");
  await expect(pane.getByText(E2E_SIBLING_BODY)).toBeVisible();
  await expect(pane.getByText("Path traversal is not allowed")).toHaveCount(0);
  await pane.getByRole("textbox", { name: "File source" }).click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("export const edited = true;\n");
  await page.keyboard.press("Meta+s");
  await expect(pane.locator(".state")).toHaveText(/Saved/);
  expect(await readFile(file, "utf8")).toBe("export const edited = true;\n");
});
