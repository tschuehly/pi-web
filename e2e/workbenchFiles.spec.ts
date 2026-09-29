import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { E2E_NOTES_BODY, E2E_REPORT_BODY, E2E_SEARCH_MATCHES, E2E_SIBLING_BODY } from "./isolatedPiWeb";

async function openChat(page: Page): Promise<void> {
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.goto(url);
  await expect(page.getByRole("link", { name: "the notes" })).toBeVisible();
}

test("file search shows a first page without error and loads the next page", async ({ page }) => {
  await openChat(page);
  await page.getByRole("button", { name: "Search files" }).click();
  const pane = page.locator("workbench-files-pane");
  await pane.getByRole("combobox", { name: "Search files" }).fill("entry-");
  const results = pane.getByRole("option");
  await expect(results).toHaveCount(100);
  await expect(pane.getByText("More files may match. Load more to continue searching.")).toBeVisible();
  await expect(pane.getByText("Search failed")).toHaveCount(0);
  await pane.getByRole("button", { name: "Load more" }).click();
  await expect(results).toHaveCount(E2E_SEARCH_MATCHES);
  await expect(pane.getByText("Search failed")).toHaveCount(0);
});

test("a Markdown file link in Chat opens that file in the Files pane", async ({ page }) => {
  await openChat(page);
  await page.getByRole("link", { name: "the notes" }).click();
  const pane = page.locator("workbench-files-pane");
  await expect(pane.getByTitle("docs/notes.md")).toBeVisible();
  await expect(pane.getByText(E2E_NOTES_BODY)).toBeVisible();
  expect(page.url()).toBe(process.env["PI_WEB_E2E_CHAT_URL"]);
});

test("a file link in a Chat outside every registered project opens in the Files pane", async ({ page }) => {
  const url = process.env["PI_WEB_E2E_ADHOC_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.goto(url);
  await page.getByRole("link", { name: "the report" }).click();
  const pane = page.locator("workbench-files-pane");
  await expect(pane.getByTitle("report.md")).toBeVisible();
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
  await expect(pane.getByTitle("generator.ts")).toBeVisible();
  await expect(pane.getByText(E2E_SIBLING_BODY)).toBeVisible();
  await expect(pane.getByText("Path traversal is not allowed")).toHaveCount(0);
  await pane.getByRole("button", { name: "Edit" }).click();
  await pane.getByRole("textbox", { name: "File source" }).fill("export const edited = true;\n");
  await pane.getByRole("button", { name: "Save" }).click();
  await expect(pane.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(file, "utf8")).toBe("export const edited = true;\n");
});
