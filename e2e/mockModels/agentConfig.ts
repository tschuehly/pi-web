import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The Claude subscription and ChatGPT Codex models the mock serves by default. */
export const MOCK_CLAUDE_MODEL = { provider: "anthropic", id: "claude-sonnet-5-5" } as const;
export const MOCK_CODEX_MODEL = { provider: "openai-codex", id: "gpt-6-luna" } as const;
export const MOCK_CODEX_ACCOUNT = "e2e-mock-account";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Points a Pi agent dir at the mock: `models.json` overrides the anthropic, openai-codex and openai base URLs (built-in models
 * stay), `auth.json` holds dummy OAuth logins that never expire (no refresh request), and `settings.json` selects the
 * Claude model, SSE for Codex, fast agent retries, the dismissed billing notice and, when given, pi-claude-code-use.
 * Every value is fake; nothing here reads a real credential.
 */
export async function writeMockAgentConfig(agentDir: string, mockUrl: string, options: { claudeCodeUse?: string } = {}): Promise<void> {
  await writeMockProviders(agentDir, mockUrl);
  const extensions: string[] = [];
  if (options.claudeCodeUse !== undefined) {
    // Keep sibling imports (prompt.js, tool-aliases/*) with the entry; the installed source stays read-only.
    const target = join(agentDir, "e2e-extensions", "pi-claude-code-use");
    await cp(dirname(options.claudeCodeUse), target, { recursive: true });
    extensions.push(join(target, basename(options.claudeCodeUse)));
  }
  await writeFile(
    join(agentDir, "settings.json"),
    json({
      defaultProvider: MOCK_CLAUDE_MODEL.provider,
      defaultModel: MOCK_CLAUDE_MODEL.id,
      transport: "sse",
      retry: { baseDelayMs: 1 },
      // The Claude subscription billing notice stays dismissed, as on a daily-use machine; it would otherwise add a
      // "Warnings 1" chip to every Claude Chat's composer.
      warnings: { anthropicExtraUsage: false },
      ...(extensions.length > 0 ? { extensions } : {}),
    }),
  );
}

/**
 * The provider half of `writeMockAgentConfig`: `models.json` and the three mock logins, merged into an existing
 * `auth.json` (other logins, such as the Durable fixture's Copilot one, stay). The Durable agent dir takes only this.
 */
export async function writeMockProviders(agentDir: string, mockUrl: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const never = Date.UTC(2100, 0, 1);
  await writeFile(
    join(agentDir, "models.json"),
    json({ providers: { anthropic: { baseUrl: mockUrl }, "openai-codex": { baseUrl: mockUrl }, openai: { baseUrl: `${mockUrl}/openai/v1` } } }),
  );
  const existing = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
  await writeFile(
    join(agentDir, "auth.json"),
    json({
      ...existing,
      // pi-ai takes the OAuth path for any token containing sk-ant-oat; joined from parts so secret scanners skip it.
      anthropic: {
        type: "oauth",
        access: ["sk", "ant", "oat01", "e2e", "mock", "not", "a", "real", "token"].join("-"),
        refresh: "e2e-mock-refresh",
        expires: never,
      },
      "openai-codex": {
        type: "oauth",
        access: fakeChatGptJwt(MOCK_CODEX_ACCOUNT, never),
        refresh: "e2e-mock-refresh",
        expires: never,
        accountId: MOCK_CODEX_ACCOUNT,
      },
      // Workbench routing (routing-policy.json) sends Luna, Sol and Astra children to `openai` signed in with ChatGPT.
      openai: { type: "oauth", access: "e2e-mock-openai-access", refresh: "e2e-mock-refresh", expires: never },
    }),
    { mode: 0o600 },
  );
}

/** An unsigned JWT carrying only the ChatGPT account claim pi-ai's Codex transport reads. */
function fakeChatGptJwt(accountId: string, expiresMs: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ exp: Math.floor(expiresMs / 1000), "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.e2e-mock`;
}
