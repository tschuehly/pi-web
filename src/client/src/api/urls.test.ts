import { afterEach, describe, expect, it, vi } from "vitest";
import { messagePath, sessionMediaPath, sessionMediaUrl, workspaceFilePreviewPath, workspaceFilePreviewUrl } from "./urls";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("session media URLs", () => {
  it("encodes each binary route segment and cwd once, with no leading application slash", () => {
    expect(sessionMediaPath({ id: "session /?#%", cwd: "/repo +/?#%" }, "media /?#%", "remote /?#%"))
      .toBe("api/machines/remote%20%2F%3F%23%25/sessions/session%20%2F%3F%23%25/media/media%20%2F%3F%23%25?cwd=%2Frepo+%2B%2F%3F%23%25");
  });

  it.each(["https://pi.example.test/", "https://pi.example.test/nested/pi-web/"])("resolves native image routes exactly once under %s", (baseURI) => {
    vi.stubEnv("BASE_URL", "./");
    vi.stubGlobal("document", { baseURI });
    expect(sessionMediaUrl({ id: "s /?", cwd: "/repo with spaces" }, "a".repeat(64), "remote /?"))
      .toBe(`${baseURI}api/machines/remote%20%2F%3F/sessions/s%20%2F%3F/media/${"a".repeat(64)}?cwd=%2Frepo+with+spaces`);
  });

  it("opts both string and cwd-scoped paginated history into reference media", () => {
    expect(messagePath("s /?", { limit: 25, before: 50 }))
      .toBe("api/machines/local/sessions/s%20%2F%3F/messages?limit=25&before=50&media=reference");
    expect(messagePath({ id: "s", cwd: "/repo" })).toBe("api/machines/local/sessions/s/messages?cwd=%2Frepo&media=reference");
  });
});

describe("workspace file preview URLs", () => {
  it("builds an application-relative path with every dynamic value encoded once", () => {
    const path = workspaceFilePreviewPath(
      "project /?#%",
      "workspace /?#%",
      "reports/a b?#%/résumé.pdf",
      {
        machineId: "remote /?#%",
        modifiedAt: "2026-06-25T00:00:00.000Z +?",
        download: true,
      },
    );

    expect(path).toBe("api/machines/remote%20%2F%3F%23%25/projects/project%20%2F%3F%23%25/workspaces/workspace%20%2F%3F%23%25/file/preview?path=reports%2Fa+b%3F%23%25%2Fr%C3%A9sum%C3%A9.pdf&v=2026-06-25T00%3A00%3A00.000Z+%2B%3F&download=1");
  });

  it("resolves the preview path exactly once under a canonical nested deployment", () => {
    vi.stubEnv("BASE_URL", "./");
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/nested/pi-web/" });

    const url = workspaceFilePreviewUrl("project /?", "workspace /?", "docs/report #1.html", {
      machineId: "remote /?",
      download: true,
    });

    expect(url).toBe("https://pi.example.test/nested/pi-web/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%2F%3F/file/preview?path=docs%2Freport+%231.html&download=1");
  });
});
