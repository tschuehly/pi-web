import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib";
import type { BarrierState, ErrorPreset, JournalEntry, MockProvider, RequestKind, Script, ScriptStatus, Step, StopReason, Turn, Usage } from "./types";

/**
 * A scripted stand-in for the Claude subscription (Anthropic Messages, as pi-ai's OAuth path plus pi-claude-code-use
 * 2.2.1 send it) and ChatGPT Codex (OpenAI Responses over SSE, as pi-ai's openai-codex sends it). One process-wide
 * instance serves the whole e2e run; specs drive it over the `/__mock/` control API (see client.ts and README.md).
 * It never forwards anything: unknown paths get 404.
 */
export type MockModelServer = { readonly url: string; close(): Promise<void> };

/** Anthropic OAuth requests must open with this system block (pi-ai `buildParams`). */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
/** pi-ai 1.3/1.4 `claudeCodeTools`: the only flat tool names a Claude subscription request may carry. */
const CLAUDE_CODE_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "KillShell", "NotebookEdit", "Skill", "Task", "TaskOutput", "TodoWrite", "WebFetch", "WebSearch"];
/** pi-claude-code-use rewrites these out of every system prompt. */
const FORBIDDEN_SYSTEM_PHRASES = ["pi itself", "pi .md files", "pi packages"];
/** PI WEB's session-naming system prompt (src/server/sessions/sessionNameGenerator.ts). */
const TITLE_PROMPT = "Generate a concise title for a coding-agent chat session";
const SECRET_HEADERS = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);

type Json = Record<string, unknown>;
type Barrier = { reached: boolean; released: boolean; onReached: (() => void)[]; onReleased: (() => void)[] };
type Entry = { status: ScriptStatus; turns: Turn[] };
type ErrorSpec = { status: number; type: string; message: string; headers?: Record<string, string> };

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export async function startMockModelServer(options: { port?: number } = {}): Promise<MockModelServer> {
  let scripts: Entry[] = [];
  let journal: JournalEntry[] = [];
  let barriers = new Map<string, Barrier>();
  let strict = true;
  let seq = 0;
  let nextScriptId = 1;

  const barrier = (name: string): Barrier => {
    let found = barriers.get(name);
    if (found === undefined) barriers.set(name, (found = { reached: false, released: false, onReached: [], onReleased: [] }));
    return found;
  };

  const control = async (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const route = `${req.method ?? "GET"} ${path}`;
    if (route === "GET /__mock/health") return send(200, { ok: true });
    if (route === "POST /__mock/reset") {
      // Held responses stay held; their barriers are gone, so release them first if a spec needs them to finish.
      scripts = [];
      journal = [];
      barriers = new Map();
      strict = true;
      nextScriptId = 1;
      return send(200, { ok: true });
    }
    if (route === "POST /__mock/config") {
      const body = await readJson(req);
      if (typeof body["strict"] === "boolean") strict = body["strict"];
      return send(200, { strict });
    }
    if (route === "POST /__mock/scripts") {
      const script = (await readJson(req)) as Script;
      if (!Array.isArray(script.turns) || script.turns.length === 0) return send(400, { error: "turns must be a non-empty array" });
      const id = script.id ?? `script-${String(nextScriptId++)}`;
      scripts.push({ turns: script.turns, status: { id, kind: script.kind ?? "chat", ...(script.provider ? { provider: script.provider } : {}), ...(script.match ? { match: script.match } : {}), total: script.turns.length, used: 0 } });
      return send(200, { id });
    }
    if (route === "GET /__mock/scripts") return send(200, scripts.map((entry) => entry.status));
    if (req.method === "DELETE" && path.startsWith("/__mock/scripts/")) {
      const id = decodeURIComponent(path.slice("/__mock/scripts/".length));
      scripts = scripts.filter((entry) => entry.status.id !== id);
      return send(200, { ok: true });
    }
    if (route === "GET /__mock/journal") {
      const provider = query.get("provider");
      const contains = query.get("contains");
      const kind = query.get("kind");
      const since = Number(query.get("since") ?? "0");
      return send(200, journal.filter((entry) => entry.seq > since && (provider === null || entry.provider === provider) && (kind === null || entry.kind === kind) && (contains === null || entry.lastUserText.includes(contains) || JSON.stringify(entry.body).includes(contains))));
    }
    if (route === "GET /__mock/barriers") {
      return send(200, [...barriers].map(([name, state]): BarrierState => ({ name, reached: state.reached, released: state.released })));
    }
    const barrierRoute = /^\/__mock\/barriers\/([^/]+)\/(wait|release)$/.exec(path);
    if (req.method === "POST" && barrierRoute !== null) {
      const name = decodeURIComponent(barrierRoute[1] ?? "");
      const state = barrier(name);
      if (barrierRoute[2] === "release") {
        state.released = true;
        for (const done of state.onReleased.splice(0)) done();
        return send(200, { name, reached: state.reached, released: true });
      }
      // Long poll: answers once a response reaches the barrier, or 408 after `timeoutMs` (default 30 s).
      if (!state.reached) {
        const timeoutMs = Number(query.get("timeoutMs") ?? "30000");
        const reached = await Promise.race([new Promise<true>((done) => state.onReached.push(() => { done(true); })), sleep(timeoutMs, false)]);
        if (!reached) return send(408, { name, reached: false, error: `Barrier ${name} was not reached within ${String(timeoutMs)} ms` });
      }
      return send(200, { name, reached: true, released: state.released });
    }
    return send(404, { error: `Unknown control route ${route}` });
  };

  const model = async (req: IncomingMessage, res: ServerResponse, provider: MockProvider, path: string): Promise<void> => {
    const body = decodeBody(req.headers["content-encoding"], await readBody(req));
    const headers = redactHeaders(req.headers);
    const violations = provider === "anthropic" ? claudeViolations(req.headers, body) : codexViolations(req.headers, body);
    const userTexts = provider === "anthropic" ? anthropicUserTexts(body) : codexUserTexts(body);
    const systemText = JSON.stringify(provider === "anthropic" ? body["system"] ?? "" : body["instructions"] ?? "");
    const kind: RequestKind = systemText.includes(TITLE_PROMPT) ? "title" : "chat";
    const entry: JournalEntry = {
      seq: ++seq, at: new Date().toISOString(), provider, kind, transport: "http", method: req.method ?? "POST", path,
      ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
      headers, auth: authKind(req.headers), body, violations, answeredBy: "echo", toolCalls: [], status: 200, outcome: "pending",
      lastUserText: userTexts.at(-1) ?? "",
    };
    journal.push(entry);
    res.on("close", () => { if (entry.outcome === "pending") entry.outcome = "client-closed"; });
    if (violations.length > 0 && strict) {
      entry.answeredBy = "rejected";
      const spec = { status: 400, type: "invalid_request_error", message: `Mock rejected the request shape: ${violations.join("; ")}` };
      entry.status = spec.status;
      entry.outcome = "error";
      return provider === "anthropic" ? anthropicHttpError(res, spec) : codexHttpError(res, spec);
    }
    const allText = userTexts.join("\n");
    const script = scripts.find((candidate) => candidate.status.used < candidate.status.total
      && candidate.status.kind === kind
      && (candidate.status.provider === undefined || candidate.status.provider === provider)
      && (candidate.status.match === undefined || allText.includes(candidate.status.match)));
    let turn: Turn;
    // One short line: long echoes reflow in narrow Grid tiles and shift scroll anchors in unrelated specs.
    if (script === undefined) turn = kind === "title" ? "Mock title" : `echo: ${truncate((entry.lastUserText.split("\n")[0] ?? "").trim(), 60)}`;
    else {
      entry.answeredBy = { script: script.status.id, turn: script.status.used };
      turn = script.turns[script.status.used] ?? "";
      script.status.used += 1;
    }
    const { steps, stopReason, usage } = typeof turn === "string" ? { steps: [{ text: turn }], stopReason: undefined, usage: undefined } : Array.isArray(turn) ? { steps: turn, stopReason: undefined, usage: undefined } : turn;
    const writer = provider === "anthropic" ? anthropicWriter(res, body) : codexWriter(res, body);
    await play(steps, writer, entry, res, (name) => {
      const state = barrier(name);
      state.reached = true;
      for (const done of state.onReached.splice(0)) done();
      return state.released ? Promise.resolve() : new Promise<void>((done) => state.onReleased.push(done));
    }, stopReason, usage);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    const handle = path.startsWith("/__mock/") ? control(req, res, path, url.searchParams)
      : req.method === "POST" && path === "/v1/messages" ? model(req, res, "anthropic", path)
        : req.method === "POST" && path === "/codex/responses" ? model(req, res, "openai-codex", path)
          : Promise.resolve(void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `The mock model server does not serve ${req.method ?? ""} ${path}` })));
    handle.catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  // Codex prefers a WebSocket; refusing the upgrade makes pi-ai fall back to SSE (the harness also sets transport=sse).
  server.on("upgrade", (req, socket) => {
    journal.push({
      seq: ++seq, at: new Date().toISOString(), provider: "openai-codex", kind: "chat", transport: "websocket", method: req.method ?? "GET", path: new URL(req.url ?? "/", "http://mock").pathname,
      headers: redactHeaders(req.headers), auth: authKind(req.headers), body: null, violations: [], answeredBy: "rejected", toolCalls: [], status: 501, outcome: "error", lastUserText: "",
    });
    socket.end("HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, "127.0.0.1", () => { done(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Mock model server has no TCP address");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => { done(); });
    }),
  };
}

// ─── Playing a turn ──────────────────────────────────────────────────────────

type Writer = {
  started: boolean;
  text(text: string): void;
  thinking(text: string): void;
  /** Streams the call under the request's declared wire name and returns that name. */
  toolCall(name: string, args: Record<string, unknown>, id: string | undefined): string;
  finish(stopReason: StopReason, usage: Usage): void;
  streamError(spec: ErrorSpec): void;
  httpError(spec: ErrorSpec): void;
};

async function play(steps: Step[], writer: Writer, entry: JournalEntry, res: ServerResponse, hold: (name: string) => Promise<void>, stopReason: StopReason | undefined, usage: Usage | undefined): Promise<void> {
  let calledTool = false;
  for (const step of steps) {
    if (res.destroyed) return;
    if ("barrier" in step) await hold(step.barrier);
    else if ("delayMs" in step) await sleep(step.delayMs);
    else if ("drop" in step) {
      entry.outcome = "dropped";
      res.socket?.destroy();
      return;
    } else if ("error" in step) {
      const spec = errorSpec(step.error, entry.provider);
      entry.status = writer.started ? 200 : spec.status;
      entry.outcome = "error";
      if (writer.started) writer.streamError(spec);
      else writer.httpError(spec);
      return;
    } else if ("text" in step) writer.text(step.text);
    else if ("thinking" in step) writer.thinking(step.thinking);
    else {
      calledTool = true;
      entry.toolCalls.push(writer.toolCall(step.toolCall.name, step.toolCall.args ?? {}, step.toolCall.id));
    }
  }
  if (res.destroyed) return;
  writer.finish(stopReason ?? (calledTool ? "tool_use" : "end_turn"), usage ?? {});
  entry.outcome = "completed";
}

function errorSpec(error: Extract<Step, { error: unknown }>["error"], provider: MockProvider): ErrorSpec {
  if (typeof error !== "string") return { type: provider === "anthropic" ? "api_error" : "server_error", message: `Mock error ${String(error.status)}`, ...error };
  const presets: Record<ErrorPreset, [number, string, string, string]> = {
    overloaded: [529, "overloaded_error", "server_is_overloaded", "Overloaded"],
    rate_limit: [429, "rate_limit_error", "rate_limit_exceeded", "Rate limited by the mock"],
    server: [500, "api_error", "server_error", "Internal server error from the mock"],
    invalid_request: [400, "invalid_request_error", "invalid_request_error", "Invalid request from the mock"],
    auth: [401, "authentication_error", "invalid_api_key", "Invalid credentials from the mock"],
  };
  const [status, anthropicType, codexCode, message] = presets[error];
  return { status: provider === "openai-codex" && error === "overloaded" ? 503 : status, type: provider === "anthropic" ? anthropicType : codexCode, message };
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Split text into a few streaming deltas (word groups) so clients see partial output. */
function chunks(text: string): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [""];
  const out: string[] = [];
  for (let index = 0; index < words.length; index += 3) out.push(words.slice(index, index + 3).join(""));
  return out;
}

/** The name the request declared for a scripted Pi tool name: exact, case-insensitive (`Read`), or an `mcp__<server>__<name>` alias. */
function wireToolName(name: string, declared: string[]): string {
  const lower = name.toLowerCase();
  const sanitized = `__${lower.replace(/[^a-z0-9_]/g, "_")}`;
  return declared.find((candidate) => candidate === name)
    ?? declared.find((candidate) => candidate.toLowerCase() === lower)
    ?? declared.find((candidate) => candidate.toLowerCase().startsWith("mcp__") && candidate.toLowerCase().endsWith(sanitized))
    ?? name;
}

function declaredTools(body: Json): Json[] {
  const out: Json[] = [];
  const walk = (tools: unknown) => {
    for (const tool of asArray(tools)) {
      if (!isObject(tool)) continue;
      if (typeof tool["name"] === "string") out.push(tool);
      walk(tool["tools"]);
    }
  };
  walk(body["tools"]);
  // Tools added mid-conversation are declared by their transcript tool_addition block (pi-ai 1.4 native tool changes).
  for (const block of messageBlocks(body)) if (block["type"] === "tool_addition") walk([toolChange(block)["definition"]]);
  return out;
}

const messageBlocks = (body: Json): Json[] => asArray(body["messages"]).flatMap((message) => isObject(message) ? asArray(message["content"]).filter(isObject) : []);
const toolChange = (block: Json): Json => isObject(block["tool"]) ? block["tool"] : {};

const ids = () => {
  let n = 0;
  return (prefix: string) => `${prefix}_mock${String(Date.now())}${String(++n).padStart(3, "0")}`;
};

// ─── Anthropic Messages ──────────────────────────────────────────────────────

function anthropicWriter(res: ServerResponse, body: Json): Writer {
  const id = ids();
  const declared = declaredTools(body).map((tool) => String(tool["name"]));
  const event = (type: string, data: Json) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
  let index = 0;
  let outputTokens = 0;
  const writer: Writer = {
    started: false,
    text: (text) => { start(); block({ type: "text", text: "" }, chunks(text).map((delta) => ({ type: "text_delta", text: delta }))); outputTokens += chunks(text).length; },
    thinking: (text) => { start(); block({ type: "thinking", thinking: "", signature: "" }, [...chunks(text).map((delta) => ({ type: "thinking_delta", thinking: delta })), { type: "signature_delta", signature: `mock-signature-${String(index)}` }]); },
    toolCall: (name, args, callId) => {
      start();
      const json = JSON.stringify(args);
      const half = Math.ceil(json.length / 2);
      const wire = wireToolName(name, declared);
      block({ type: "tool_use", id: callId ?? id("toolu"), name: wire, input: {} }, [json.slice(0, half), json.slice(half)].map((part) => ({ type: "input_json_delta", partial_json: part })));
      return wire;
    },
    finish: (stopReason, usage) => {
      start();
      event("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output ?? outputTokens } });
      event("message_stop", {});
      res.end();
    },
    streamError: (spec) => { event("error", { error: { type: spec.type, message: spec.message } }); res.end(); },
    httpError: (spec) => { anthropicHttpError(res, spec); },
  };
  const usageAtStart = { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  function start() {
    if (writer.started) return;
    writer.started = true;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": id("req") });
    event("message_start", { message: { id: id("msg"), type: "message", role: "assistant", model: body["model"], content: [], stop_reason: null, stop_sequence: null, usage: usageAtStart } });
  }
  function block(contentBlock: Json, deltas: Json[]) {
    const at = index++;
    event("content_block_start", { index: at, content_block: contentBlock });
    for (const delta of deltas) event("content_block_delta", { index: at, delta });
    event("content_block_stop", { index: at });
  }
  return writer;
}

function anthropicHttpError(res: ServerResponse, spec: ErrorSpec): void {
  res.writeHead(spec.status, { "content-type": "application/json", ...spec.headers }).end(JSON.stringify({ type: "error", error: { type: spec.type, message: spec.message } }));
}

function claudeViolations(headers: IncomingMessage["headers"], body: Json): string[] {
  const out: string[] = [];
  const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value.join(",") : value ?? ""; };
  if (!/^Bearer sk-ant-oat/.test(header("authorization"))) out.push("authorization must be an sk-ant-oat OAuth bearer token");
  if (header("x-api-key") !== "") out.push("x-api-key must be absent on the subscription path");
  const betas = header("anthropic-beta").split(",").map((beta) => beta.trim());
  for (const beta of ["claude-code-20250219", "oauth-2025-04-20"]) if (!betas.includes(beta)) out.push(`anthropic-beta must include ${beta}`);
  if (!header("user-agent").startsWith("claude-cli/")) out.push("user-agent must be claude-cli/<version>");
  if (header("x-app") !== "cli") out.push("x-app must be cli");
  if (body["stream"] !== true) out.push("stream must be true");
  if (typeof body["model"] !== "string") out.push("model is required");
  if (typeof body["max_tokens"] !== "number") out.push("max_tokens is required");
  if (!Array.isArray(body["messages"])) out.push("messages must be an array");
  const system = asArray(body["system"]);
  const first = system[0];
  if (!isObject(first) || first["text"] !== CLAUDE_CODE_IDENTITY) out.push("system must open with the Claude Code identity block");
  for (const block of system) {
    const text = isObject(block) && typeof block["text"] === "string" ? block["text"] : "";
    for (const phrase of FORBIDDEN_SYSTEM_PHRASES) if (text.includes(phrase)) out.push(`system prompt must not contain "${phrase}" (pi-claude-code-use rewrites it)`);
  }
  const checkName = (name: unknown, where: string) => {
    if (typeof name !== "string") return;
    if (name.length > 128 || !/^[A-Za-z0-9_-]+$/.test(name)) out.push(`${where} ${name} is not a valid Anthropic tool name`);
    else if (!CLAUDE_CODE_TOOLS.includes(name) && !name.startsWith("mcp__") && name !== "__pi_deferred_placeholder__") out.push(`${where} ${name} must be a Claude Code tool or an mcp__ alias`);
  };
  for (const tool of asArray(body["tools"])) if (isObject(tool) && tool["type"] === undefined) checkName(tool["name"], "tool");
  for (const block of messageBlocks(body)) {
    if (block["type"] === "tool_use") checkName(block["name"], "tool_use");
    // pi-ai 1.4 adds by `tool.definition`, removes (and 1.0 adds) by `tool.name` reference.
    else if (block["type"] === "tool_addition" || block["type"] === "tool_removal") {
      const tool = toolChange(block);
      checkName(isObject(tool["definition"]) ? tool["definition"]["name"] : tool["name"], String(block["type"]));
    }
  }
  return out;
}

/** User prompts and tool results, in order; the system prompt is excluded. */
function anthropicUserTexts(body: Json): string[] {
  const out: string[] = [];
  const text = (content: unknown): string => typeof content === "string" ? content
    : asArray(content).map((block) => isObject(block) ? (typeof block["text"] === "string" ? block["text"] : block["type"] === "tool_result" ? text(block["content"]) : "") : "").filter(Boolean).join("\n");
  for (const message of asArray(body["messages"])) if (isObject(message) && message["role"] === "user") out.push(text(message["content"]));
  return out;
}

// ─── OpenAI Responses (Codex) ────────────────────────────────────────────────

function codexWriter(res: ServerResponse, body: Json): Writer {
  const id = ids();
  const tools = declaredTools(body);
  const declared = tools.map((tool) => String(tool["name"]));
  const responseId = id("resp");
  const output: Json[] = [];
  const event = (type: string, data: Json) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
  const item = (added: Json, deltas: [string, Json][], done: Json) => {
    start();
    const outputIndex = output.length;
    output.push(done);
    event("response.output_item.added", { output_index: outputIndex, item: added });
    for (const [type, data] of deltas) event(type, { output_index: outputIndex, item_id: added["id"], ...data });
    event("response.output_item.done", { output_index: outputIndex, item: done });
  };
  let outputTokens = 0;
  const writer: Writer = {
    started: false,
    text: (text) => {
      const itemId = id("msg");
      outputTokens += chunks(text).length;
      item({ type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
        chunks(text).map((delta) => ["response.output_text.delta", { content_index: 0, delta }]),
        { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
    },
    thinking: (text) => {
      const itemId = id("rs");
      item({ type: "reasoning", id: itemId, summary: [] },
        chunks(text).map((delta) => ["response.reasoning_summary_text.delta", { summary_index: 0, delta }]),
        { type: "reasoning", id: itemId, summary: [{ type: "summary_text", text }], encrypted_content: `mock-encrypted-${itemId}` });
    },
    toolCall: (name, args, callId) => {
      const wire = wireToolName(name, declared);
      const itemId = id("fc");
      const call = callId ?? id("call");
      if (tools.find((tool) => tool["name"] === wire)?.["type"] === "custom") {
        // Grammar (custom) tools take one free-form input: the first string argument.
        const input = String(Object.values(args).find((value) => typeof value === "string") ?? "");
        item({ type: "custom_tool_call", id: itemId, call_id: call, name: wire, input: "" },
          [["response.custom_tool_call_input.delta", { delta: input }], ["response.custom_tool_call_input.done", { input }]],
          { type: "custom_tool_call", id: itemId, call_id: call, name: wire, input, status: "completed" });
        return wire;
      }
      const json = JSON.stringify(args);
      item({ type: "function_call", id: itemId, call_id: call, name: wire, arguments: "", status: "in_progress" },
        [["response.function_call_arguments.delta", { delta: json }], ["response.function_call_arguments.done", { arguments: json }]],
        { type: "function_call", id: itemId, call_id: call, name: wire, arguments: json, status: "completed" });
      return wire;
    },
    finish: (stopReason, usage) => {
      start();
      const input = usage.input ?? 0;
      const out = usage.output ?? outputTokens;
      event("response.completed", {
        response: {
          id: responseId, object: "response", model: body["model"], output,
          status: stopReason === "max_tokens" ? "incomplete" : "completed",
          ...(stopReason === "max_tokens" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          usage: { input_tokens: input, output_tokens: out, total_tokens: input + out, input_tokens_details: { cached_tokens: usage.cacheRead ?? 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        },
      });
      res.end();
    },
    streamError: (spec) => { event("error", { code: spec.type, message: spec.message }); res.end(); },
    httpError: (spec) => { codexHttpError(res, spec); },
  };
  function start() {
    if (writer.started) return;
    writer.started = true;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    event("response.created", { response: { id: responseId, object: "response", status: "in_progress", model: body["model"], output: [] } });
  }
  return writer;
}

function codexHttpError(res: ServerResponse, spec: ErrorSpec): void {
  res.writeHead(spec.status, { "content-type": "application/json", ...spec.headers }).end(JSON.stringify({ error: { type: spec.type, code: spec.type, message: spec.message } }));
}

function codexViolations(headers: IncomingMessage["headers"], body: Json): string[] {
  const out: string[] = [];
  const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value.join(",") : value ?? ""; };
  const token = /^Bearer (.+)$/.exec(header("authorization"))?.[1] ?? "";
  const account = jwtAccount(token);
  if (account === undefined) out.push("authorization must be a ChatGPT bearer JWT with a chatgpt_account_id claim");
  else if (header("chatgpt-account-id") !== account) out.push("chatgpt-account-id must match the token's account");
  if (header("originator") === "") out.push("originator header is required");
  if (header("openai-beta") !== "responses=experimental") out.push("OpenAI-Beta must be responses=experimental");
  if (body["stream"] !== true) out.push("stream must be true");
  if (body["store"] !== false) out.push("store must be false");
  if (typeof body["model"] !== "string") out.push("model is required");
  if (typeof body["instructions"] !== "string") out.push("instructions are required");
  if (!Array.isArray(body["input"])) out.push("input must be an array");
  return out;
}

function jwtAccount(token: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"));
    const claim = isObject(payload) ? payload["https://api.openai.com/auth"] : undefined;
    return isObject(claim) && typeof claim["chatgpt_account_id"] === "string" ? claim["chatgpt_account_id"] : undefined;
  } catch {
    return undefined;
  }
}

function codexUserTexts(body: Json): string[] {
  const out: string[] = [];
  const text = (content: unknown): string => typeof content === "string" ? content
    : asArray(content).map((part) => isObject(part) && typeof part["text"] === "string" ? part["text"] : "").filter(Boolean).join("\n");
  for (const item of asArray(body["input"])) {
    if (!isObject(item)) continue;
    if (item["role"] === "user") out.push(text(item["content"]));
    else if (item["type"] === "function_call_output" || item["type"] === "custom_tool_call_output") out.push(text(item["output"]));
  }
  return out;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  return decodeBody(undefined, await readBody(req));
}

/** pi-ai's Codex transport zstd-compresses request bodies. */
function decodeBody(encoding: string | undefined, raw: Buffer): Json {
  const bytes = encoding === "zstd" ? zstdDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : encoding === "br" ? brotliDecompressSync(raw) : raw;
  if (bytes.length === 0) return {};
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  return isObject(parsed) ? parsed : { value: parsed };
}

function redactHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SECRET_HEADERS.has(name) ? "[redacted]" : Array.isArray(value) ? value.join(",") : value ?? ""]));
}

function authKind(headers: IncomingMessage["headers"]): JournalEntry["auth"] {
  const authorization = headers.authorization ?? "";
  if (authorization.startsWith("Bearer sk-ant-oat")) return "oauth";
  if (/^Bearer [^.]+\.[^.]+\.[^.]*$/.test(authorization)) return "jwt";
  if (headers["x-api-key"] !== undefined || authorization !== "") return "api-key";
  return "none";
}
