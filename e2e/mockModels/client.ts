import type { BarrierState, JournalEntry, MockProvider, RequestKind, Script, ScriptStatus } from "./types";

export type * from "./types";

/** Spec-side handle on the run's mock model server (started by e2e/isolatedPiWeb.ts; URL in PI_WEB_E2E_MOCK_URL). */
export function mockModels(url = process.env["PI_WEB_E2E_MOCK_URL"]) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (url === undefined || url === "") throw new Error("PI_WEB_E2E_MOCK_URL is not set: the mock model server was not started (PI_WEB_E2E_MOCK_MODELS=0?)");
    const response = await fetch(`${url}/__mock/${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(`Mock ${method} ${path} failed (${String(response.status)}): ${JSON.stringify(value)}`);
    return value as T;
  };
  return {
    url,
    /** Forget scripts, journal and barriers; strict shape validation back on. */
    reset: () => call<{ ok: true }>("POST", "reset"),
    /** Register a script; returns its id. */
    script: async (script: Script) => (await call<{ id: string }>("POST", "scripts", script)).id,
    scripts: () => call<ScriptStatus[]>("GET", "scripts"),
    removeScript: (id: string) => call<{ ok: true }>("DELETE", `scripts/${encodeURIComponent(id)}`),
    /** `strict: false` answers requests that break the subscription shape instead of rejecting them with 400. */
    configure: (config: { strict?: boolean }) => call<{ strict: boolean }>("POST", "config", config),
    journal: (filter: { provider?: MockProvider; kind?: RequestKind; contains?: string; since?: number } = {}) => {
      const query = new URLSearchParams(Object.entries(filter).map(([key, value]) => [key, String(value)]));
      return call<JournalEntry[]>("GET", `journal?${query.toString()}`);
    },
    /** Resolves once a response is held at `name`; rejects after `timeoutMs`. */
    waitForBarrier: (name: string, timeoutMs = 30_000) => call<BarrierState>("POST", `barriers/${encodeURIComponent(name)}/wait?timeoutMs=${String(timeoutMs)}`),
    /** Let a held response continue; releasing before it is reached lets it pass straight through. */
    release: (name: string) => call<BarrierState>("POST", `barriers/${encodeURIComponent(name)}/release`),
    barriers: () => call<BarrierState[]>("GET", "barriers"),
  };
}
