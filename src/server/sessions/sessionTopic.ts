import { createHash, randomUUID } from "node:crypto";
import type { PromptImageAttachment } from "../../shared/apiTypes.js";
import { base64ByteLength, parsePromptAttachments } from "../../shared/promptAttachments.js";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SessionTopicAttention, SessionTopicChoice, SessionTopicMessage, SessionTopicSnapshot, SessionTopicSummary } from "../../shared/apiTypes.js";

export const TOPIC_ID = "focus";
export const TOPIC_OPEN_TYPE = "pi-web.topic.open";
export const TOPIC_INPUT_TYPE = "pi-web.topic.input";
export const TOPIC_POST_TYPE = "pi-web.topic.post";
export const TOPIC_ACK_TYPE = "pi-web.topic.ack";
export const TOPIC_TEXT_LIMIT = 16_384;

export function topicId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("Invalid topic id");
  return value;
}

export function topicText(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || value.length > TOPIC_TEXT_LIMIT) throw new Error("text must be a non-empty string of at most 16384 characters");
  return value;
}

export function topicImages(value: unknown): PromptImageAttachment[] {
  if (Array.isArray(value) && value.some((item: unknown) => record(item) && item["kind"] === "image" && item["reference"] === undefined)) throw new Error("topic images require a [PIC_n] reference");
  const images = parsePromptAttachments(value, { maxAttachments: 4 });
  let total = 0;
  for (const image of images) {
    const size = base64ByteLength(image.data);
    if (size > 8 * 1024 * 1024) throw new Error("topic image exceeds 8 MiB");
    total += size;
    if (total > 32 * 1024 * 1024) throw new Error("topic images exceed 32 MiB");
    if (Buffer.from(image.data, "base64").toString("base64") !== image.data) throw new Error("invalid base64 image data");
  }
  return images;
}

export function topicImageDigest(images: PromptImageAttachment[]): string | undefined {
  // A retry can use a newly selected file or reference; only ordered image bytes
  // and MIME determine whether it is the same message.
  return images.length ? createHash("sha256").update(JSON.stringify(images.map(({ mimeType, data }) => ({ mimeType, data })))).digest("hex") : undefined;
}

export function topicTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 160 || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("Invalid topic title");
  return value.trim();
}

export function topicChoices(value: unknown): SessionTopicChoice[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8 || value.some((choice) => !record(choice) || typeof choice["label"] !== "string" || !choice["label"].trim() || choice["label"].length > 160 || (typeof choice["label"] === "string" && Array.from(choice["label"]).some((char) => char.charCodeAt(0) < 32)) || typeof choice["detail"] !== "string" || choice["detail"].length > 512)) throw new Error("Invalid topic choices");
  return value.map((choice: SessionTopicChoice) => ({ label: choice.label, detail: choice.detail }));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Projection accepts only entries on the selected Pi branch, never ordinary assistant chat. */
export function topicSnapshots(entries: readonly unknown[], busy: boolean): SessionTopicSnapshot[] {
  const topics = new Map<string, SessionTopicSnapshot>();
  const acknowledged = new Map<string, string>();
  const ensure = (id: string, title: string) => {
    let topic = topics.get(id);
    if (!topic) { topic = { topicId: id, title, messages: [], state: "idle", attention: "clear" }; topics.set(id, topic); }
    return topic;
  };
  for (const entry of entries) {
    if (!record(entry)) continue;
    const data = entry["type"] === "custom_message" ? entry["details"] : entry["data"];
    if (!record(data) || typeof data["topicId"] !== "string") continue;
    const id = data["topicId"];
    if (entry["type"] === "custom" && entry["customType"] === TOPIC_OPEN_TYPE && id !== TOPIC_ID && typeof data["title"] === "string") {
      ensure(id, data["title"]);
      continue;
    }
    if (id === TOPIC_ID && !topics.has(id) && (entry["customType"] === TOPIC_INPUT_TYPE || entry["customType"] === TOPIC_POST_TYPE)) ensure(id, "Focus");
    const topic = topics.get(id);
    if (!topic) continue;
    if (entry["type"] === "custom" && entry["customType"] === TOPIC_ACK_TYPE && typeof data["messageId"] === "string") {
      acknowledged.set(id, data["messageId"]);
      continue;
    }
    const user = entry["type"] === "custom_message" && entry["customType"] === TOPIC_INPUT_TYPE;
    const assistant = entry["type"] === "custom" && entry["customType"] === TOPIC_POST_TYPE;
    if ((!user && !assistant) || typeof entry["id"] !== "string" || typeof entry["timestamp"] !== "string" || typeof data["text"] !== "string") continue;
    const attention: SessionTopicAttention | undefined = assistant && (data["attention"] === "question" || data["attention"] === "update" || data["attention"] === "working" || data["attention"] === "clear") ? data["attention"] : undefined;
    let choices: SessionTopicChoice[] | undefined;
    if (assistant) { try { choices = topicChoices(data["choices"]); } catch { /* Ignore malformed legacy choices; keep the message. */ } }
    const message: SessionTopicMessage = { id: entry["id"], role: user ? "user" : "assistant", text: data["text"], createdAt: entry["timestamp"],
      ...(user && typeof data["requestId"] === "string" ? { requestId: data["requestId"] } : {}), ...(attention ? { attention } : {}), ...(choices ? { choices } : {}) };
    if (user && Array.isArray(entry["content"])) {
      const images = entry["content"].flatMap((part: unknown) => record(part) && part["type"] === "image" && typeof part["mimeType"] === "string" && typeof part["data"] === "string"
        ? [{ mimeType: part["mimeType"], data: part["data"] }] : []);
      if (images.length) message.images = images;
    }
    topic.messages.push(message);
  }
  for (const topic of topics.values()) {
    const last = topic.messages.at(-1);
    topic.state = last?.role === "user" ? busy ? "pending" : "unanswered" : "idle";
    const lastAssistant = [...topic.messages].reverse().find((message) => message.role === "assistant");
    topic.attention = last?.role === "user" ? busy ? "working" : "unanswered" : lastAssistant?.attention === "update" && acknowledged.get(topic.topicId) === lastAssistant.id ? "clear" : lastAssistant?.attention ?? "clear";
  }
  return [...topics.values()];
}

export function topicSnapshot(entries: readonly unknown[], busy: boolean, id = TOPIC_ID): SessionTopicSnapshot {
  const topic = topicSnapshots(entries, busy).find((item) => item.topicId === id);
  if (!topic) throw new Error("Topic not found");
  return topic;
}

export function topicSummaries(entries: readonly unknown[], busy: boolean): SessionTopicSummary[] {
  const opened = new Map<string, { at: string; summary: string }>();
  for (const entry of entries) {
    if (record(entry) && entry["type"] === "custom" && entry["customType"] === TOPIC_OPEN_TYPE && record(entry["data"]) && typeof entry["data"]["topicId"] === "string" && typeof entry["timestamp"] === "string") {
      opened.set(entry["data"]["topicId"], { at: entry["timestamp"], summary: typeof entry["data"]["summary"] === "string" ? entry["data"]["summary"] : "" });
    }
  }
  return topicSnapshots(entries, busy).map((topic) => {
    const latest = topic.messages.at(-1);
    const count = latest?.images?.length ?? 0;
    const preview = latest?.text !== undefined && latest.text !== "" ? latest.text : count > 0 ? `${String(count)} image${count === 1 ? "" : "s"}` : opened.get(topic.topicId)?.summary ?? "";
    return { topicId: topic.topicId, title: topic.title, preview, attention: topic.attention, updatedAt: latest?.createdAt ?? opened.get(topic.topicId)?.at ?? "" };
  });
}

const TopicOpenParams = Type.Object({ title: Type.String({ minLength: 1, maxLength: 160 }), summary: Type.Optional(Type.String({ maxLength: 512 })) });
const TopicPostParams = Type.Object({ topicId: Type.String(), text: Type.String({ minLength: 1, maxLength: TOPIC_TEXT_LIMIT }), attention: Type.Optional(Type.Union([Type.Literal("question"), Type.Literal("update"), Type.Literal("working"), Type.Literal("clear")])), choices: Type.Optional(Type.Array(Type.Object({ label: Type.String(), detail: Type.String() }), { maxItems: 8 })) });

export function createTopicOpenToolDefinition(open: (sessionId: string, title: string, summary?: string) => string) {
  return defineTool<typeof TopicOpenParams, { topicId: string }>({
    name: "topic_open", label: "Open topic", description: "Create a named topic in this session.", parameters: TopicOpenParams,
    execute(_id, params, _signal, _onUpdate, ctx) {
      const id = open(ctx.sessionManager.getSessionId(), topicTitle(params.title), params.summary);
      return Promise.resolve({ content: [{ type: "text" as const, text: `Opened topic ${id}.` }], details: { topicId: id, title: params.title } });
    },
  });
}

export function createTopicPostToolDefinition(post: (sessionId: string, topicId: string, text: string, attention?: SessionTopicAttention, choices?: SessionTopicChoice[]) => string) {
  return defineTool<typeof TopicPostParams, { entryId: string }>({
    name: "topic_post", label: "Post to topic", description: "Post to a topic on this session, separate from ordinary chat and ask_user.",
    promptSnippet: "topic_open creates a named topic; topic_post replies in an existing topic.",
    promptGuidelines: ["When a hidden [Topic: id | title] message asks for a response, use topic_post with that topicId. Ordinary prose is not a topic reply. Use attention question for owner questions, update for acknowledgable news, working for progress, clear for completion. This does not replace ask_user."],
    parameters: TopicPostParams,
    execute(_id, params, _signal, _onUpdate, ctx) {
      const entryId = post(ctx.sessionManager.getSessionId(), topicId(params.topicId), topicText(params.text), params.attention, topicChoices(params.choices));
      return Promise.resolve({ content: [{ type: "text" as const, text: `Posted to topic (${entryId}).` }], details: { entryId } });
    },
  });
}

export function newTopicId(): string { return randomUUID(); }
