# Mock model endpoints for e2e

The e2e harness (`e2e/isolatedPiWeb.ts`) starts a scripted mock of the two subscription providers. Legacy and Durable Chats talk to it instead of the real APIs. No real credentials are used and no live requests are sent.

| Provider | Path | Dialect |
| --- | --- | --- |
| `anthropic` (Claude subscription) | `POST /v1/messages` | Anthropic Messages, SSE: text, thinking with signature, `tool_use`, stop reasons, usage, errors |
| `openai-codex` (ChatGPT) | `POST /codex/responses` | OpenAI Responses, SSE: reasoning summary, `output_text`, `function_call` and `custom_tool_call`, `response.completed`/`incomplete`, errors |

Chat Completions is not served: no provider in the fixture agent dir uses it.

## What the harness sets up

The mock is on by default. Set `PI_WEB_E2E_MOCK_MODELS=0` to turn it off, and `mock-smoke.spec.ts` then skips itself. When the mock is on, the harness writes these files to the isolated agent dir (`agentConfig.ts`):

- `models.json` points `providers.anthropic.baseUrl` and `providers["openai-codex"].baseUrl` at the mock. The built-in models stay listed.
- `auth.json` holds dummy OAuth logins that never expire: an `sk-ant-oat` token for Claude and an unsigned JWT for Codex (account `e2e-mock-account`).
- `settings.json` sets:
  - default model `anthropic/claude-sonnet-5-5` (`MOCK_CLAUDE_MODEL`); `MOCK_CODEX_MODEL` is `openai-codex/gpt-6-luna`
  - `transport: "sse"`
  - `retry.baseDelayMs: 1`
  - the Claude billing notice dismissed
  - the pi-claude-code-use extension
- The extension is a copy of `PI_WEB_E2E_CLAUDE_CODE_USE`. When that is unset, the harness copies the installed `~/.pi/agent/npm/node_modules/@benvargas/pi-claude-code-use/extensions/index.ts`, if it exists.
- `ANTHROPIC_*` and `OPENAI_*` variables from your shell never reach the children.

Durable hosts use their own agent dir (`<root>/durable-agent`, `PI_WEB_DURABLE_AGENT_DIR`). With the mock on, the harness writes the same `models.json` and the two mock logins there too (`writeMockProviders`), next to the fixture's fake Copilot login; its `settings.json` stays its own. The host honors that `models.json` for `anthropic` and `openai-codex` only from pi-workbench `feat/durable-host-slice1-20261022` after the mock merge (`modelsJsonBaseUrl` in `packages/durable-pilot/src/providers.ts`). An older host would send requests to the real APIs with the dummy tokens, so point `PI_WEB_E2E_DURABLE_HOST` at a host that has this change. Copilot is not mocked. Durable Chats still open on the scripted `faux` model, so switch to `MOCK_CLAUDE_MODEL` or `MOCK_CODEX_MODEL` in the model picker (see `e2e/durable/mock-smoke.spec.ts`).

## Scripting turns

```ts
import { mockModels } from "../mockModels/client";
const mock = mockModels();
test.beforeEach(async () => { await mock.reset(); });

const marker = `queue-${Date.now()}`;           // put it in the Chat's first prompt
await mock.script({
  provider: "anthropic",                          // optional
  match: marker,                                  // substring of the request's prompts or tool results
  turns: [
    [{ thinking: "Check the file." }, { toolCall: { name: "read", args: { path: "docs/notes.md" } } }],
    "Plain text is a one-text turn.",
    { steps: [{ text: "cut short" }], stopReason: "max_tokens", usage: { input: 1200, output: 40 } },
  ],
});
```

- **One turn per request.** Each matching request uses the script's next turn. A marker in the first prompt keys the whole Chat, because every later request replays that prompt.
- **Order.** Scripts are tried in the order they were registered. When a script runs out of turns, the request goes to the next matching script, then to the default.
- **Default answer.** An unmatched request gets the echo `echo: <first line of the last prompt or tool result, ≤ 60 chars>`.
- **Steps:**
  - `{ text }`
  - `{ thinking }`
  - `{ toolCall: { name, args, id? } }`
  - `{ barrier: "name" }`
  - `{ delayMs }`
  - `{ error }`
  - `{ drop: true }`, which cuts the connection
- **Tool names.** Script tools by their Pi name. The mock answers with the name the request declared: `read` becomes `Read` on the Claude path, and `ask_user` becomes `mcp__pi__ask_user` or another `mcp__<server>__ask_user` alias. Declared names include the request's `tools` and the definition of every `tool_addition` block in `messages`, so a tool enabled mid-conversation (for example by `web_enable`) is answered with its alias too.
- **Stop reason.** It defaults to `tool_use` when the turn calls a tool and `end_turn` otherwise. Codex maps `max_tokens` to `incomplete`.
- **Errors.** The `error` presets are `overloaded` (529, or 503 for Codex), `rate_limit` (429), `server` (500), `invalid_request` (400) and `auth` (401). You can also pass `{ status, type?, message?, headers? }`.
  - An error before any output is an HTTP error. An error after output has started is streamed as an `error` event.
  - Pi retries transient errors up to 3 times. Each retry is a new request, so script one error turn per attempt.
- **Session titles.** PI WEB's session-naming request (`kind: "title"`) never uses a chat script. It gets `Mock title` unless you register a script with `kind: "title"`.

## Barriers: hold a response, then release it

```ts
await mock.script({ match: marker, turns: [[{ text: "Working…" }, { barrier: "mid" }, { text: "done" }]] });
await send(page, `${marker} go`);
await mock.waitForBarrier("mid");     // long poll; the partial answer is on screen now
// …assert the in-flight state, queue a follow-up, press Stop, kill the host…
await mock.release("mid");            // the rest streams; releasing first lets it pass straight through
```

Specs wait on barriers and on UI state, never on sleeps. If a barrier is the first step, the response is held before any byte is sent.

## Journal

`await mock.journal({ provider?, kind?, contains?, since? })` lists every request in order. Each entry has:

- `seq`, `provider`, `kind`, `model`, `path`
- `headers`: `authorization`, `x-api-key` and `cookie` read `[redacted]`
- `auth`: `oauth`, `jwt`, `api-key` or `none`
- `body`: the request body as JSON, decompressed
- `lastUserText`
- `answeredBy`: `{ script, turn }`, `echo` or `rejected`
- `toolCalls`: the wire tool names the mock answered with, in order
- `status`
- `outcome`: `pending`, `completed`, `error`, `dropped` or `client-closed`
- `violations`

The mock checks the shape of every request. A request with violations gets a 400 that names them, and the message shows in the Chat.

- **Claude:**
  - an `sk-ant-oat` bearer token and no `x-api-key`
  - `anthropic-beta` includes `claude-code-20250219` and `oauth-2025-04-20`
  - `user-agent: claude-cli/…` and `x-app: cli`
  - the system prompt opens with the Claude Code identity block
  - no "pi itself", "pi .md files" or "pi packages" in the system prompt
  - every untyped tool name, `tool_use` name and transcript tool-change name (`tool_addition` `tool.definition.name`, `tool_removal` `tool.name`) is a Claude Code tool, an `mcp__` alias or Pi's deferred placeholder
- **Codex:**
  - a bearer JWT with a `chatgpt_account_id` claim that matches `chatgpt-account-id`
  - an `originator` header and `OpenAI-Beta: responses=experimental`
  - `stream: true`, `store: false`, `instructions` and `input`

To write a negative control, call `mock.configure({ strict: false })` so the mock answers malformed requests instead of rejecting them.

## Kill and reopen

The mock runs in the Playwright runner process. Stopping a session host or restarting the daemon does not reset it.

1. Hold the turn at a barrier and wait for it (`waitForBarrier`).
2. Stop the host, for example with `POST api/sessions/<id>/stop` as `e2e/durableChat.spec.ts` does, or kill the daemon.
3. Check that the held entry reads `outcome: "client-closed"`. Use `release()` if the turn should still finish for someone else.
4. Reopen or reload the Chat.
5. Count replays with `(await mock.journal({ contains: marker })).length`. A resumed run shows as new entries. A correct restore shows no duplicate tool effects in `body` and no extra turns used (`mock.scripts()` reports `used` / `total`).

## Control API (for non-Playwright callers)

Base URL: `PI_WEB_E2E_MOCK_URL`. All bodies are JSON.

| Method and path | What it does |
| --- | --- |
| `GET /__mock/health` | Health check |
| `POST /__mock/reset` | Clear scripts, journal and barriers |
| `POST /__mock/config` | Set `{ strict }` |
| `POST /__mock/scripts` | Register a script |
| `GET /__mock/scripts` | List scripts |
| `DELETE /__mock/scripts/<id>` | Remove a script |
| `GET /__mock/journal?provider=&kind=&contains=&since=` | Query the journal |
| `GET /__mock/barriers` | List barriers |
| `POST /__mock/barriers/<name>/wait?timeoutMs=` | Wait for a barrier; returns 408 on timeout |
| `POST /__mock/barriers/<name>/release` | Release a barrier |
