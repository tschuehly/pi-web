import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { fixture, text, tool } from "./fleet";
export type Event = { seq: number; type: string; origin?: string; text?: string; of?: number[]; target?: number };
export async function events(file: string): Promise<Event[]> { return (await readFile(`${file}.events.jsonl`, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event); }
export async function openAtelier(page: Page, context: BrowserContext) {
  const name = `page-${Date.now()}.html`;
  const file = join(fixture().project, name);
  await writeFile(file, '<!doctype html><html><head><meta charset="utf-8"><title>Fleet Page</title><script type="module" src="atelier.js"></script></head><body><main><section atl-key="proposal" atl-ver="1" atl-decide="Approve|Revise"><h1>Fleet proposal</h1><p>Keep the output with the Chat.</p><button atl-comment>Comment</button><button atl-request="rerun">Run check</button></section></main></body></html>');
  expect((await tool(page, "tools_enable", { group: "atelier" })).isError).not.toBe(true);
  const result = await tool(page, "atelier", { action: "open", page: name });
  expect(result.isError, text(result.content)).not.toBe(true);
  const url = result.details?.url ?? /Page open: (\S+)/.exec(text(result.content))?.[1];
  expect(url).toBeTruthy();
  const tab = await context.newPage();
  await tab.goto(url!);
  await expect(tab.getByRole("heading", { name: "Fleet proposal" })).toBeVisible();
  await expect(tab.getByRole("group", { name: "Decision on proposal" })).toBeVisible();
  return { tab, url: url!, file, name };
}
export async function comment(tab: Page, file: string, value: string) {
  await tab.getByRole("button", { name: "Comment", exact: true }).click();
  await tab.getByRole("textbox", { name: "Comment on proposal", exact: true }).fill(value);
  await tab.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await events(file)).filter((event) => event.type === "comment" && event.text === value).length).toBe(1);
  return (await events(file)).find((event) => event.type === "comment" && event.text === value)!;
}
