import type { PromptImageAttachment } from "../../shared/apiTypes";
import { isSupportedImageMimeType } from "../../shared/promptAttachments";

const DATABASE = "pi-web-topic-image-drafts";
const STORE = "images";

export interface PendingTopicImagePost {
  requestId: string;
  text: string;
  status: "sending" | "queued" | "unknown" | "conflict" | "invalid";
  imageCount?: number;
}

export interface TopicImageDraftState {
  images: PromptImageAttachment[];
  pending?: PendingTopicImagePost;
}

function isStoredImage(value: unknown): value is PromptImageAttachment {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "image"
    && "reference" in value && typeof value.reference === "string" && /^\[PIC_[1-9]\d*\]$/.test(value.reference)
    && "mimeType" in value && isSupportedImageMimeType(value.mimeType)
    && "data" in value && typeof value.data === "string";
}

function isStoredPending(value: unknown): value is PendingTopicImagePost {
  return typeof value === "object" && value !== null
    && "requestId" in value && typeof value.requestId === "string"
    && "text" in value && typeof value.text === "string"
    && "status" in value && ["sending", "queued", "unknown", "conflict", "invalid"].includes(String(value.status))
    && (!("imageCount" in value) || typeof value.imageCount === "number");
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Image drafts need browser storage"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error("Image draft storage failed")); };
  });
}

export async function loadTopicImageState(key: string): Promise<TopicImageDraftState> {
  if (typeof indexedDB === "undefined") return { images: [] };
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => {
        const value: unknown = request.result;
        // Legacy drafts were arrays; an image and its request id now share one IndexedDB record.
        if (Array.isArray(value)) { resolve({ images: value.filter(isStoredImage) }); return; }
        if (typeof value === "object" && value !== null && "images" in value && Array.isArray(value.images)) {
          const pending = "pending" in value && isStoredPending(value.pending) ? value.pending : undefined;
          resolve({ images: value.images.filter(isStoredImage), ...(pending ? { pending } : {}) });
          return;
        }
        resolve({ images: [] });
      };
      request.onerror = () => { reject(request.error ?? new Error("Image draft read failed")); };
    });
  } finally { database.close(); }
}

export async function saveTopicImageState(key: string, state: TopicImageDraftState): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      if (state.images.length > 0 || state.pending) transaction.objectStore(STORE).put(state, key);
      else transaction.objectStore(STORE).delete(key);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("Image draft save failed")); };
      transaction.onabort = () => { reject(transaction.error ?? new Error("Image draft save failed")); };
    });
  } finally { database.close(); }
}
