// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { marked } from "marked";
import { toSafeMarkdownHtml } from "./markdown";
import { DEFAULT_CODE_BLOCK_POLICY, PLAIN_CODE_BLOCK_POLICY } from "./codeBlockPolicy";
import { markdownWorkspaceContext, type MarkdownWorkspaceContext } from "./workspaceLinks";

const workspace: MarkdownWorkspaceContext = { machineId: "remote /1", projectId: "project /1", workspaceId: "work /1", root: "/srv/work" };

function render(text: string, context?: MarkdownWorkspaceContext): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = toSafeMarkdownHtml(text, context);
  return div;
}

function link(text: string, context?: MarkdownWorkspaceContext): HTMLAnchorElement {
  const anchor = render(text, context).querySelector("a");
  if (anchor === null) throw new Error("Expected a Markdown link");
  return anchor;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

describe("final Markdown HTML cache", () => {
  it("reuses sanitized HTML without parsing or rebuilding DOM, including across route query changes", () => {
    vi.stubEnv("BASE_URL", "./");
    window.history.replaceState(null, "", "/nested/pi/?view=chat");
    // Every uncached render parses into a fresh <template>, so no element creation means no parse.
    const createElement = vi.spyOn(document, "createElement");
    const text = "[cache reuse](./cached.txt)\n\n| A |\n| - |\n| B |";
    const first = toSafeMarkdownHtml(text, workspace);
    expect(first).toContain('data-workspace-file="cached.txt"');
    expect(first).toContain('class="table-scroll"');
    createElement.mockClear();
    window.history.replaceState(null, "", "/nested/pi/?view=workspace");
    expect(toSafeMarkdownHtml(text, { ...workspace })).toBe(first);
    expect(createElement).not.toHaveBeenCalled();
  });

  it("isolates effective application bases and ignores the base for context-free HTML", () => {
    vi.stubEnv("BASE_URL", "./");
    const text = "[base isolation](cached.txt)";
    window.history.replaceState(null, "", "/first/");
    expect(toSafeMarkdownHtml(text, workspace)).toContain("/first/api/");
    window.history.replaceState(null, "", "/second/");
    expect(toSafeMarkdownHtml(text, workspace)).toContain("/second/api/");
    vi.stubEnv("BASE_URL", "/fixed/");
    expect(toSafeMarkdownHtml(text, workspace)).toContain("/fixed/api/");

    const plain = toSafeMarkdownHtml(text);
    const createElement = vi.spyOn(document, "createElement");
    vi.stubEnv("BASE_URL", "/elsewhere/");
    expect(toSafeMarkdownHtml(text)).toBe(plain);
    expect(createElement).not.toHaveBeenCalled();
  });

  it("evicts old entries rather than growing without bound", () => {
    const text = "cache eviction sentinel";
    toSafeMarkdownHtml(text);
    for (let index = 0; index < 300; index++) toSafeMarkdownHtml(`cache eviction ${String(index)}`);
    const createElement = vi.spyOn(document, "createElement");
    toSafeMarkdownHtml(text);
    expect(createElement).toHaveBeenCalledExactlyOnceWith("template");
  });
});

describe("plain Markdown code blocks", () => {
  it.each([
    ["```text\nfirst\n  second\n```", "first\n  second\n"],
    ["~~~text\nfirst\n  second\n~~~", "first\n  second\n"],
    ["> ```text\n> first\n>   second\n> ```", "first\n  second\n"],
    ["    first\n      second", "first\n  second\n"],
    ["```text\nunclosed", "unclosed\n"],
  ])("keeps block content as literal text without pre/code markup: %s", (text, expected) => {
    const root = document.createElement("div");
    root.innerHTML = toSafeMarkdownHtml(text, undefined, undefined, true, PLAIN_CODE_BLOCK_POLICY);
    expect(root.querySelector(".plain-code-block")?.textContent).toBe(expected);
    expect(root.querySelector("pre, code")).toBeNull();
  });

  it("keeps code inert while preserving surrounding Markdown and inline code", () => {
    const root = document.createElement("div");
    root.innerHTML = toSafeMarkdownHtml('## Heading\n\n**Prose** with `inline`.\n\n```html\n<img src="x" onerror="bad()">\n**literal** & text\n```', undefined, undefined, true, PLAIN_CODE_BLOCK_POLICY);
    expect(root.querySelector("h2")?.textContent).toBe("Heading");
    expect(root.querySelector("strong")?.textContent).toBe("Prose");
    expect(root.querySelector("code")?.textContent).toBe("inline");
    expect(root.querySelector(".plain-code-block")?.textContent).toBe('<img src="x" onerror="bad()">\n**literal** & text\n');
    expect(root.querySelector("img, script, pre")).toBeNull();
  });

  it("does not reuse enhanced HTML for plain blocks or plain HTML when rendering is enabled", () => {
    const text = "```text\ncode-block cache isolation\n```";
    const rendered = toSafeMarkdownHtml(text);
    const plain = toSafeMarkdownHtml(text, undefined, undefined, true, PLAIN_CODE_BLOCK_POLICY);
    expect(rendered).toContain("<pre><code");
    expect(plain).not.toContain("<pre>");
    expect(plain).toContain('class="plain-code-block"');
    expect(toSafeMarkdownHtml(text)).toBe(rendered);
    expect(toSafeMarkdownHtml(text, undefined, undefined, true, PLAIN_CODE_BLOCK_POLICY)).toBe(plain);
  });

  it.each(["plain", "code"] as const)("generates optional copy controls with inert %s source before mounting", (presentation) => {
    const text = '```html\n<img src="x" onerror="bad()"> & literal\n```';
    const policy = { ...PLAIN_CODE_BLOCK_POLICY, presentation };
    const root = document.createElement("div");
    root.innerHTML = toSafeMarkdownHtml(text, undefined, undefined, true, policy);
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelectorAll(".code-block-frame")).toHaveLength(presentation === "code" ? 1 : 0);
    root.innerHTML = toSafeMarkdownHtml(text, undefined, undefined, true, { ...policy, copy: true });
    expect(root.querySelectorAll(".code-block-wrapper")).toHaveLength(1);
    expect(root.querySelectorAll('button[aria-label="Copy code block"]')).toHaveLength(1);
    const copy = root.querySelector(".code-copy-button");
    expect(copy?.parentElement?.classList.contains("code-block-header")).toBe(true);
    expect(copy?.parentElement?.nextElementSibling?.tagName).toBe(presentation === "code" ? "PRE" : "DIV");
    expect(copy?.parentElement?.querySelector(".code-block-label")?.textContent).toBe("html");
    expect(root.querySelector(presentation === "code" ? "pre code" : ".plain-code-block")?.textContent).toBe('<img src="x" onerror="bad()"> & literal\n');
    expect(root.querySelector("img, script")).toBeNull();
    expect(toSafeMarkdownHtml(text, undefined, undefined, true, policy)).not.toContain("code-copy-button");
  });

  it.each([
    ["```typescript\nsource\n```", "typescript"],
    ['```bash title="demo"\nsource\n```', "bash"],
    ["```\nsource\n```", null],
    ["    source", null],
    ["```<img\nsource\n```", "<img"],
  ])("labels the frame with only an inert fence language, or nothing: %s", (text, language) => {
    const root = document.createElement("div");
    root.innerHTML = toSafeMarkdownHtml(text);
    expect(root.querySelector(".code-block-frame > .code-block-header")).not.toBeNull();
    expect(root.querySelector(".code-block-label")?.textContent ?? null).toBe(language);
    expect(root.querySelectorAll(".code-block-copy")).toHaveLength(1);
    expect(root.querySelector("img, script, select")).toBeNull();
  });

  it("retains the native frame and language label when copying is disabled", () => {
    const root = document.createElement("div");
    root.innerHTML = toSafeMarkdownHtml("```typescript\nsource\n```", undefined, undefined, true, { ...DEFAULT_CODE_BLOCK_POLICY, copy: false });
    expect(root.querySelector(".code-block-frame .code-block-label")?.textContent).toBe("typescript");
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe("source\n");
  });

  it("reuses HTML across overflow and preview choices but not presentation or copy choices", () => {
    const text = "```text\nindependent block policy cache\n```";
    const plain = toSafeMarkdownHtml(text, undefined, undefined, true, PLAIN_CODE_BLOCK_POLICY);
    const parse = vi.spyOn(marked, "parse");
    expect(toSafeMarkdownHtml(text, undefined, undefined, true, { ...PLAIN_CODE_BLOCK_POLICY, overflow: "scroll", previews: true })).toBe(plain);
    expect(parse).not.toHaveBeenCalled();
    expect(toSafeMarkdownHtml(text, undefined, undefined, true, { ...PLAIN_CODE_BLOCK_POLICY, presentation: "code" })).toContain("<pre><code");
    expect(toSafeMarkdownHtml(text, undefined, undefined, true, { ...DEFAULT_CODE_BLOCK_POLICY, copy: false })).not.toContain("code-copy-button");
    expect(toSafeMarkdownHtml(text, undefined, undefined, true, { ...PLAIN_CODE_BLOCK_POLICY, copy: true })).toContain("code-copy-button");
    expect(parse).toHaveBeenCalledTimes(2);
  });
});

describe("workspace Markdown downloads", () => {
  it.each([
    ["reports/result.zip", "reports/result.zip"],
    ["./reports/result.zip", "reports/result.zip"],
    ["././reports//./result.zip", "reports/result.zip"],
    ["/srv/work/./reports//result.zip", "reports/result.zip"],
    ["%2E/reports/%2E/result.zip", "reports/result.zip"],
    ["reports/../result.zip", "result.zip"],
    ["/srv/work/reports/result.zip", "reports/result.zip"],
    ["reports/a%20%231%3F%25.zip", "reports/a #1?%.zip"],
    ["report.pdf?version=2#page=3", "report.pdf"],
  ])("routes %s through the existing download endpoint", (destination, path) => {
    vi.stubEnv("BASE_URL", "/nested/pi/");
    const anchor = link(`[download](${destination})`, workspace);
    expect(anchor.getAttribute("data-workspace-file")).toBe(path);
    const url = new URL(anchor.href);
    expect(url.pathname).toBe("/nested/pi/api/machines/remote%20%2F1/projects/project%20%2F1/workspaces/work%20%2F1/file/preview");
    expect(url.searchParams.get("path")).toBe(path);
    expect(url.searchParams.get("download")).toBe("1");
  });

  it.each(["https://example.com/file", "http://example.com", "mailto:hello@example.com", "#section", "//example.com/file"])("preserves browser link %s", (destination) => {
    const anchor = link(`[link](${destination})`, workspace);
    expect(anchor.getAttribute("href")).toBe(destination);
    expect(anchor.rel).toBe("noreferrer noopener");
  });

  it("does not share resolved links between workspaces, machines or context-free consumers", () => {
    const text = "[download](result.zip)";
    const first = link(text, workspace).href;
    for (const field of ["machineId", "projectId", "workspaceId"] as const) {
      const second = link(text, { ...workspace, [field]: "different" }).href;
      expect(second).not.toBe(first);
      expect(second).toContain("/different/");
    }
    expect(link(text).hasAttribute("href")).toBe(false);
    expect(link(text, workspace).href).toBe(first);
    const absolute = "[download](/srv/work/result.zip)";
    expect(link(absolute, workspace).href).toContain("download=1");
    expect(link(absolute, { ...workspace, root: "/another" }).getAttribute("data-outside-file")).toBe("/srv/work/result.zip");
  });

  it("links bare absolute destinations with spaces, leaving code untouched", () => {
    const text = "[IMG_2430.MOV](/Users/me/Bilder & Videos/Hochzeit Jana/IMG_2430.MOV) and `[x](/a b/c.mov)`";
    const div = render(text, workspace);
    const anchor = div.querySelector("a");
    expect(anchor?.textContent).toBe("IMG_2430.MOV");
    expect(anchor?.getAttribute("data-outside-file")).toBe("/Users/me/Bilder & Videos/Hochzeit Jana/IMG_2430.MOV");
    expect(new URL(anchor?.href ?? "").searchParams.get("path")).toBe("IMG_2430.MOV");
    expect(div.querySelector("code")?.textContent).toBe("[x](/a b/c.mov)");
    expect(render("[relative](a b.mov)", workspace).querySelector("a")).toBeNull();
  });

  it.each([
    ["../outside.zip", "/srv/outside.zip", "/srv", "outside.zip"],
    ["/srv/work-other/file", "/srv/work-other/file", "/srv/work-other", "file"],
    ["/api/status", "/api/status", "/api", "status"],
  ])("routes Chat link %s outside the folder through its own folder workspace", (destination, absolute, folder, path) => {
    vi.stubEnv("BASE_URL", "/nested/pi/");
    const anchor = link(`[outside](${destination})`, workspace);
    expect(anchor.hasAttribute("data-workspace-file")).toBe(false);
    expect(anchor.getAttribute("data-outside-file")).toBe(absolute);
    expect(anchor.target).toBe("_self");
    const url = new URL(anchor.href);
    expect(url.pathname).toBe(`/nested/pi/api/machines/remote%20%2F1/projects/folder/workspaces/${encodeURIComponent(`folder:${folder}`)}/file/preview`);
    expect(url.searchParams.get("path")).toBe(path);
  });

  it("isolates identical nested Markdown by source path and rejects escapes", () => {
    const text = "[sibling](./target.txt) [parent](../shared.txt) [escape](../../../../outside.txt)";
    const first = render(text, { ...workspace, sourcePath: "docs/a/notes.md" });
    const second = render(text, { ...workspace, sourcePath: "docs/b/notes.md" });
    expect([...first.querySelectorAll("a")].map((a) => a.getAttribute("data-workspace-file"))).toEqual(["docs/a/target.txt", "docs/shared.txt", null]);
    expect([...second.querySelectorAll("a")].map((a) => a.getAttribute("data-workspace-file"))).toEqual(["docs/b/target.txt", "docs/shared.txt", null]);
    expect(first.querySelectorAll("a")[2]?.hasAttribute("href")).toBe(false);
    expect(second.querySelector("a")?.href).not.toBe(first.querySelector("a")?.href);
  });

  it("keeps unsafe schemes, images and literal HTML out of download resolution", () => {
    const result = render('[bad](javascript:alert%281%29) [bad](data:text/plain,hi) ![image](report.png) <a href="report.zip">raw</a>', workspace);
    expect([...result.querySelectorAll("a")].every((a) => !a.hasAttribute("href"))).toBe(true);
    expect(result.querySelector("pi-web-markdown-image")?.getAttribute("path")).toBe("report.png");
    expect(result.textContent).toContain('<a href="report.zip">raw</a>');
    expect(link("[bad](bad%ZZ.zip)", workspace).hasAttribute("href")).toBe(false);
  });

  it("routes ad-hoc folder links through the folder project segment", () => {
    const folder = "/srv/adhoc/.scratch/delivery";
    const adHoc = { id: `folder:${folder}`, projectId: "", path: folder, label: "delivery", isMain: false, effectiveConfig: { uploads: {}, attachments: {} } };
    const context = markdownWorkspaceContext("local", adHoc, { id: "s", cwd: folder });
    if (context === undefined) throw new Error("Expected ad-hoc context");
    const anchor = link(`[report](${folder}/report.md)`, context);
    expect(anchor.getAttribute("data-workspace-file")).toBe("report.md");
    expect(new URL(anchor.href).pathname).toBe(`/api/machines/local/projects/folder/workspaces/${encodeURIComponent(`folder:${folder}`)}/file/preview`);
  });

  it("only assigns context for the session's workspace", () => {
    const selected = { id: "w", projectId: "p", path: "/srv/work/", label: "work", isMain: true, effectiveConfig: { uploads: {}, attachments: {} } };
    // Only identity and path participate in context selection.
    expect(markdownWorkspaceContext("remote", undefined, { id: "s", cwd: "/srv/work" })).toBeUndefined();
    expect(markdownWorkspaceContext("remote", selected, { id: "s", cwd: "/different" })).toBeUndefined();
    expect(markdownWorkspaceContext("remote", selected, { id: "s", cwd: "/srv/work" })).toEqual({ machineId: "remote", projectId: "p", workspaceId: "w", root: "/srv/work/" });
  });
});
