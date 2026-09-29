import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readWorkspaceFile, writeWorkspaceFile } from "./fileContentService.js";

it("opens and saves a 1.1 MB Markdown file whole", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-large-text-"));
  const text = "# Index\n" + "- entry with some words\n".repeat(48_000);
  await writeFile(join(root, "index.md"), text);
  const file = await readWorkspaceFile(root, "index.md");
  expect(file).toMatchObject({ truncated: false, binary: false, content: text });
  const version = file.version;
  if (version === undefined) throw new Error("A whole file has a version");
  await writeWorkspaceFile(root, "index.md", Buffer.from(text + "- added\n"), { expectedVersion: version });
  expect((await readWorkspaceFile(root, "index.md")).content.endsWith("- added\n")).toBe(true);
});
