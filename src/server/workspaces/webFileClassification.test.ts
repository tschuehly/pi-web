import { describe, expect, it } from "vitest";
import { classifyWebWorkspaceFile } from "./webFileClassification.js";

describe("classifyWebWorkspaceFile", () => {
  it.each([
    ["clip.mp4", "video/mp4"],
    ["dir/clip.M4V", "video/mp4"],
    ["C:\\clips\\IMG_2430.MOV", "video/quicktime"],
    ["clip.webm", "video/webm"],
  ])("streams %s as %s", (path, previewMimeType) => {
    expect(classifyWebWorkspaceFile(path)).toEqual({ mediaType: "video", source: "stream", previewMimeType });
  });

  it("delegates every other path to the shared classifier", () => {
    expect(classifyWebWorkspaceFile("SPEC.PDF")).toEqual({ mediaType: "pdf", source: "stream", previewMimeType: "application/pdf" });
    expect(classifyWebWorkspaceFile("clip.mkv")).toBeUndefined();
    expect(classifyWebWorkspaceFile("folder.mp4/file")).toBeUndefined();
  });
});
