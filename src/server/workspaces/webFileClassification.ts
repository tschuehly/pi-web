import { classifyWorkspaceFile, type WorkspaceFileClassification } from "../../shared/workspaceFiles.js";

// Web/API only: the session daemon imports src/shared/workspaceFiles.ts, so video
// lives here to keep the daemon's code unchanged and web-only promotions possible.

/** Video is internal only: JSON reads identify it by `mimeType`, because older clients reject a `mediaType` outside `FileContentMediaType`. */
export type WebWorkspaceFileClassification =
  | WorkspaceFileClassification
  | { readonly mediaType: "video"; readonly source: "stream"; readonly previewMimeType: "video/mp4" | "video/quicktime" | "video/webm" };

// Videos stream with HTTP Range support and no inline size cap.
const VIDEO_MIME_TYPES: Readonly<Record<string, "video/mp4" | "video/quicktime" | "video/webm">> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** `classifyWorkspaceFile` plus streamed video previews. */
export function classifyWebWorkspaceFile(path: string): WebWorkspaceFileClassification | undefined {
  const classification = classifyWorkspaceFile(path);
  if (classification !== undefined) return classification;
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  const videoMimeType = dotIndex > slashIndex ? VIDEO_MIME_TYPES[path.slice(dotIndex).toLowerCase()] : undefined;
  return videoMimeType === undefined ? undefined : { mediaType: "video", source: "stream", previewMimeType: videoMimeType };
}
