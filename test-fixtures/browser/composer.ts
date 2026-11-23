import { api, type SessionStatus } from "../../src/client/src/api";
import { PromptEditor } from "../../src/client/src/components/PromptEditor";

api.commands = () => Promise.resolve([]);
api.models = () => Promise.resolve({ models: [{ id: "opus-h", name: "Opus", provider: "anthropic" }] });

const params = new URLSearchParams(location.search);
const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-surface-hover: #333; --pi-text: #eee; --pi-border: #555; --pi-muted: #aaa; --pi-dim: #888; --pi-success-bg: #12301c; --pi-accent: #aaf; }
  body { margin: 0; padding: 16px; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
  .tile { width: ${params.get("width") ?? "640"}px; border: 1px solid var(--pi-border); }
`;
document.head.append(style);

const status: SessionStatus = {
  sessionId: "dense-fixture", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], cost: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  model: { provider: "anthropic", id: "opus-h" },
  contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null },
};
// A Grid tile composer: dense, with model, usage, and working-mode icons beside the input.
const tile = document.createElement("div");
tile.className = "tile";
const editor = new PromptEditor();
editor.dense = true;
editor.showUsage = true;
editor.sessionId = "dense-fixture";
editor.status = status;
tile.append(editor);
document.body.append(tile);
await editor.updateComplete;
document.body.dataset["ready"] = "true";
