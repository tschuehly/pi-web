import { ASK_USER_ID_MAX_LENGTH, type AskUserImageTarget, type AskUserSubmissionImage } from "./apiTypes.js";
import { base64ByteLength, isSupportedImageMimeType, SUPPORTED_IMAGE_MIME_TYPES } from "./promptAttachments.js";

/** The most images one ask send carries, as the Durable host's closeAsk allows. */
export const ASK_USER_IMAGE_LIMIT = 16;
/** Each image's decoded size limit, as the Durable host's closeAsk allows. */
export const ASK_USER_IMAGE_BYTES = 10 * 1024 * 1024;
const strictBase64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * Untrusted answer images, checked at every trust boundary (the submit route, the ask store) as the Durable host's
 * closeAsk checks them, with its wording: a supported image type, strict base64, at most 16 images of 10 MiB each.
 */
export function parseAskUserSubmissionImages(value: unknown): AskUserSubmissionImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("images must be an array");
  if (value.length > ASK_USER_IMAGE_LIMIT) throw new Error(`answers take at most ${String(ASK_USER_IMAGE_LIMIT)} images`);
  return value.map((entry: unknown, index) => {
    const n = String(index + 1);
    if (!isRecord(entry)) throw new Error(`image ${n} must be an object`);
    const target = askUserImageTarget(entry["target"]);
    if (target === undefined) throw new Error(`image ${n} needs a target: { kind: "note" } or { kind: "question", id }`);
    const { mimeType, data, name } = entry;
    if (!isSupportedImageMimeType(mimeType)) throw new Error(`image ${n} must be ${SUPPORTED_IMAGE_MIME_TYPES.join(", ")}`);
    if (typeof data !== "string" || data === "" || data.length % 4 !== 0 || !strictBase64.test(data)) throw new Error(`image ${n} is not valid base64`);
    if (base64ByteLength(data) > ASK_USER_IMAGE_BYTES) throw new Error(`image ${n} is larger than 10 MiB`);
    return { target, mimeType, data, ...(typeof name === "string" && name !== "" ? { name } : {}) };
  });
}

/** A wire target, or `undefined` when it is neither the note nor a question id. */
export function askUserImageTarget(value: unknown): AskUserImageTarget | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, id } = value;
  if (kind === "note") return { kind };
  return kind === "question" && typeof id === "string" && id !== "" && id.length <= ASK_USER_ID_MAX_LENGTH ? { kind, id } : undefined;
}

/** Whether two targets name the same note or question. */
export function sameAskImageTarget(a: AskUserImageTarget, b: AskUserImageTarget): boolean {
  return a.kind === "note" ? b.kind === "note" : b.kind === "question" && a.id === b.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
