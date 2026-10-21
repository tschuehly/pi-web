import { normalizeContext, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";

const SESSION_NAME_TIMEOUT_MS = 10_000;
const SESSION_NAME_MAX_INPUT_CHARS = 4_000;
const SESSION_NAME_MAX_LENGTH = 60;
const FALLBACK_SESSION_NAME_MAX_WORDS = 6;

/** Explicit extension names are validated, not silently rewritten. */
export function requireInitialSessionName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()
    // eslint-disable-next-line no-control-regex -- explicit names must not contain control characters.
    || value.length > SESSION_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Initial session name must be trimmed, non-empty, at most 60 characters, and contain no control characters");
  }
  return value;
}

const SESSION_GOAL_PART_MAX_CHARS = 700;
const SKILL_INVOCATION = /^\s*(?:\/skill:\S+|<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>)/;
const SKILL_ONLY_MAX_ARGUMENT_WORDS = 3;

export interface SessionNameGenerationOptions {
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
}

/**
 * Owner text a title may use: the prompt without a leading skill invocation, or
 * undefined when the prompt is only a skill invocation with at most a short argument.
 */
export function sessionTitleInput(prompt: string): string | undefined {
  const skill = SKILL_INVOCATION.exec(prompt);
  if (skill === null) return prompt.trim() === "" ? undefined : prompt;
  const argument = prompt.slice(skill[0].length).trim();
  return argument.split(/\s+/).filter(Boolean).length <= SKILL_ONLY_MAX_ARGUMENT_WORDS ? undefined : argument;
}

export function generateShortSessionName<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, firstMessage: string, options: SessionNameGenerationOptions = {}): Promise<string | undefined> {
  return requestSessionTitle(streamFn, model, `Create a 2-6 word title for this request:\n\n${truncateInput(firstMessage)}`, options);
}

/** Regenerate a title naming the session's goal from its owner prompts and, when known, the first answer. */
export function generateSessionGoalTitle<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, prompts: readonly string[], firstAnswer?: string, options: SessionNameGenerationOptions = {}): Promise<string | undefined> {
  const parts = prompts.map((prompt, index) => `Prompt ${String(index + 1)}:\n${truncateInput(prompt, SESSION_GOAL_PART_MAX_CHARS)}`);
  if (firstAnswer !== undefined && firstAnswer.trim() !== "") parts.push(`First answer:\n${truncateInput(firstAnswer, SESSION_GOAL_PART_MAX_CHARS)}`);
  return requestSessionTitle(streamFn, model, truncateInput(`Create a 2-6 word title naming the goal of this chat session:\n\n${parts.join("\n\n")}`), options);
}

async function requestSessionTitle<TApi extends Api>(
  streamFn: StreamFn,
  model: Model<TApi>,
  content: string,
  { maxTokens = 24, thinkingLevel = "minimal", timeoutMs = SESSION_NAME_TIMEOUT_MS }: SessionNameGenerationOptions,
): Promise<string | undefined> {
  const stream = await streamFn(
    model,
    normalizeContext({
      systemPrompt: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.",
      messages: [{
        role: "user",
        content,
        timestamp: Date.now(),
      }],
    }),
    {
      maxTokens,
      ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  let streamedText = "";
  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "text_delta") streamedText += event.delta;
    if (event.type === "done") finalMessage = event.message;
    if (event.type === "error") return undefined;
  }

  return cleanSessionName(finalMessage === undefined ? streamedText : textFromAssistant(finalMessage));
}

export function fallbackSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;

  return cleanSessionName(firstMessage
    .replace(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#[\](){}<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, FALLBACK_SESSION_NAME_MAX_WORDS)
    .join(" "));
}

export function cleanSessionName(value: string): string | undefined {
  const title = (value.split("\n", 1)[0] ?? "")
    .replace(/^\s*(title|session title)\s*:\s*/i, "")
    .replace(/^\s*["'`]+|["'`.]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SESSION_NAME_MAX_LENGTH)
    .trim();
  return title === "" ? undefined : title;
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function truncateInput(value: string, maxChars = SESSION_NAME_MAX_INPUT_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}
