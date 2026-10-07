import { describe, expect, it } from "vitest";
import { fileLinkLines, outsideChatFilePath, workspaceMarkdownFilePath } from "./workspaceLinks";

const workspace = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };

describe("workspace Markdown path normalization", () => {
  it.each([".", "./", "././", "/work/./", "%2E/%2E"])("does not classify workspace-root reference %s as a file", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBeUndefined();
  });

  it.each(["./dir/../secret", "dir/%2E%2E/secret", "/work/dir/../secret"])("resolves traversal that stays inside the Chat folder in %s", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBe("secret");
    expect(outsideChatFilePath(href, workspace)).toBeUndefined();
  });

  it.each([
    ["../secret", "/secret"],
    ["../pi-web.installed/src/a.ts", "/pi-web.installed/src/a.ts"],
    ["dir/../../x/./y.md", "/x/y.md"],
    ["/elsewhere/./file", "/elsewhere/file"],
    ["/work-other/file", "/work-other/file"],
    ["/work/../secret", "/secret"],
  ])("resolves Chat link %s outside the Chat folder to %s", (href, absolute) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBeUndefined();
    expect(outsideChatFilePath(href, workspace)).toBe(absolute);
  });

  it("never treats links inside the folder, the folder itself, URLs or nested-file links as outside files", () => {
    for (const href of ["docs/a.md", "/work/docs/a.md", ".", "/work", "https://example.com/x", "#top", "..%2F..%2Fx%00"]) {
      expect(outsideChatFilePath(href, workspace), href).toBeUndefined();
    }
    expect(outsideChatFilePath("../x.md", { ...workspace, sourcePath: "notes.md" })).toBeUndefined();
    expect(outsideChatFilePath("..", { ...workspace, root: "/work/sub" })).toBe("/work");
  });

  it.each(["https://example.com/./file", "//example.com/./file", "mailto:a@example.com", "javascript:alert(1)", "#section", "?query", "/elsewhere/./file", "/work-other/file", "bad%ZZ", "dir%5Cfile", "file%00.txt"])("does not normalize excluded reference %s into a workspace file", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBeUndefined();
  });

  it("resolves relative references from the source directory without escaping the workspace", () => {
    const source = { ...workspace, sourcePath: "docs/deep/notes.md" };
    expect(workspaceMarkdownFilePath("./target%20one.txt", source)).toBe("docs/deep/target one.txt");
    expect(workspaceMarkdownFilePath("../shared.txt", source)).toBe("docs/shared.txt");
    expect(workspaceMarkdownFilePath("../../../secret", source)).toBeUndefined();
    expect(workspaceMarkdownFilePath("/work/../secret", source)).toBeUndefined();
    expect(workspaceMarkdownFilePath("/work/docs/target.txt", source)).toBe("docs/target.txt");
  });

  it("decodes only once and preserves meaningful filename characters", () => {
    expect(workspaceMarkdownFilePath("./.hidden//%252E%252E/a%20%23%3F%25.txt", workspace)).toBe(".hidden/%2E%2E/a #?%.txt");
  });
});

describe("file link line ranges", () => {
  it("reads #L40-L58, #L40, :40-58 and :40 and keeps the suffix out of the path", () => {
    const context = { machineId: "local", projectId: "p", workspaceId: "w", root: "/repo" };
    expect(fileLinkLines("src/a.ts#L40-L58")).toEqual({ start: 40, end: 58 });
    expect(fileLinkLines("src/a.ts#L40")).toEqual({ start: 40, end: 40 });
    expect(fileLinkLines("src/a.ts:40-58")).toEqual({ start: 40, end: 58 });
    expect(fileLinkLines("src/a.ts:40")).toEqual({ start: 40, end: 40 });
    expect(fileLinkLines("src/a.ts")).toBeUndefined();
    expect(workspaceMarkdownFilePath("src/a.ts:40-58", context)).toBe("src/a.ts");
    expect(workspaceMarkdownFilePath("src/a.ts#L40-L58", context)).toBe("src/a.ts");
    expect(outsideChatFilePath("/elsewhere/b.md:7", context)).toBe("/elsewhere/b.md");
  });

  it("reads a line suffix on a bare file name instead of taking it for a URL scheme", () => {
    const context = { machineId: "local", projectId: "p", workspaceId: "w", root: "/repo" };
    expect(workspaceMarkdownFilePath("README.md:40-58", context)).toBe("README.md");
    expect(workspaceMarkdownFilePath("README.md:40", { ...context, sourcePath: "docs/a.md" })).toBe("docs/README.md");
    for (const url of ["https://example.com:8080", "http://example.com:80/x", "tel:12345", "mailto:a@b.co", "C:/x/a.md:4", "C:\\x\\a.md:4"]) {
      expect(workspaceMarkdownFilePath(url, context)).toBeUndefined();
      expect(outsideChatFilePath(url, context)).toBeUndefined();
    }
  });
});
