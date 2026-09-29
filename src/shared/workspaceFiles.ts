import type { FileContentMediaType } from "./pluginApiTypes.js";

export const MAX_INLINE_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_PREVIEW_LABEL = "10 MB";
/** Text files up to this size open whole and editable in the Files pane; larger ones show this much, read-only. */
export const MAX_WORKSPACE_FILE_CONTENT_BYTES = 10 * 1024 * 1024;

/**
 * Project route segment for a Chat folder outside every registered project. Its
 * workspace id is `folder:<absolute path>` and names any existing directory. A
 * registered project persisted with this ID takes precedence.
 */
export const AD_HOC_FOLDER_PROJECT_ID = "folder";
/** Fastify route parameter limit for path-bearing ids; Node's 16 KiB header limit bounds URLs anyway. */
export const MAX_ROUTE_PARAM_LENGTH = 16 * 1024;
const AD_HOC_FOLDER_WORKSPACE_PREFIX = "folder:";

export const adHocFolderWorkspaceId = (path: string): string => `${AD_HOC_FOLDER_WORKSPACE_PREFIX}${path}`;

/** The requested folder path, or undefined when the id is not an ad-hoc folder id. */
export function adHocFolderPath(workspaceId: string): string | undefined {
  return workspaceId.startsWith(AD_HOC_FOLDER_WORKSPACE_PREFIX) ? workspaceId.slice(AD_HOC_FOLDER_WORKSPACE_PREFIX.length) : undefined;
}

type WorkspaceFileClassificationDetails =
  | { readonly mediaType: "image"; readonly source: "stream" | "text"; readonly previewMimeType: string }
  | { readonly mediaType: "html"; readonly source: "text"; readonly previewMimeType: "text/html; charset=utf-8" }
  | { readonly mediaType: "pdf"; readonly source: "stream"; readonly previewMimeType: "application/pdf" }
  | { readonly mediaType: "markdown"; readonly source: "text" };

/** Internal classification constrained to the public file-response media types. */
export type WorkspaceFileClassification = WorkspaceFileClassificationDetails & {
  readonly mediaType: FileContentMediaType;
};

// Extension classification is shared by JSON source reads, streamed previews,
// and proxy response policy. Keep this an allowlist: only classifications with
// a preview MIME type may be served as browser-rendered bytes.
//
// `source` decides what a JSON file read carries: "text" formats keep capped
// literal UTF-8 source so the viewer can offer Raw mode, while "stream" formats
// stay out of JSON and are only ever served as preview bytes.
const WORKSPACE_FILE_CLASSIFICATIONS: Readonly<Record<string, WorkspaceFileClassification>> = {
  ".avif": { mediaType: "image", source: "stream", previewMimeType: "image/avif" },
  ".bmp": { mediaType: "image", source: "stream", previewMimeType: "image/bmp" },
  ".gif": { mediaType: "image", source: "stream", previewMimeType: "image/gif" },
  ".ico": { mediaType: "image", source: "stream", previewMimeType: "image/x-icon" },
  ".jpeg": { mediaType: "image", source: "stream", previewMimeType: "image/jpeg" },
  ".jpg": { mediaType: "image", source: "stream", previewMimeType: "image/jpeg" },
  ".png": { mediaType: "image", source: "stream", previewMimeType: "image/png" },
  // SVG is markup: it previews as an image but also has readable source, so it
  // keeps literal text for Raw mode.
  ".svg": { mediaType: "image", source: "text", previewMimeType: "image/svg+xml" },
  ".webp": { mediaType: "image", source: "stream", previewMimeType: "image/webp" },
  ".htm": { mediaType: "html", source: "text", previewMimeType: "text/html; charset=utf-8" },
  ".html": { mediaType: "html", source: "text", previewMimeType: "text/html; charset=utf-8" },
  ".pdf": { mediaType: "pdf", source: "stream", previewMimeType: "application/pdf" },
  ".md": { mediaType: "markdown", source: "text" },
  ".markdown": { mediaType: "markdown", source: "text" },
};

export function classifyWorkspaceFile(path: string): WorkspaceFileClassification | undefined {
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex <= slashIndex) return undefined;
  const extension = path.slice(dotIndex).toLowerCase();
  return WORKSPACE_FILE_CLASSIFICATIONS[extension];
}

/** Return the leaf filename for either POSIX or Windows-style workspace paths. */
export function workspaceFileName(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(separatorIndex + 1);
}

/** Workspace search paging cursor: ignore-rule mode (`g` git, `n` none) plus the visited-entry offset. */
export const WORKSPACE_SEARCH_CURSOR = /^[gn](?:0|[1-9]\d{0,8})$/;
