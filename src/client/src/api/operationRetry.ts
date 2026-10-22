import { randomHex } from "../randomHex";
import { HttpRequestError, NetworkRequestError } from "./http";

/**
 * Durable Chats admit each send and answer under a client operation ID durably, so retrying one is safe across a
 * daemon restart. Legacy Chats keep their send-once behavior. A Durable Chat's listing path is `durable:<id>`.
 */
export function retriesOperations(session: { path: string }): boolean {
  return session.path.startsWith("durable:");
}

/** A new client operation ID: the daemon treats every request carrying it as the same send or answer. */
export function newOperationId(): string {
  return `op-${randomHex(16)}`;
}

/** The request may not have reached the daemon, or its answer was lost: retrying under the same ID is safe. */
export function isRetryableOperationFailure(error: unknown): boolean {
  return error instanceof NetworkRequestError || (error instanceof HttpRequestError && (error.status === 502 || error.status === 503 || error.status === 504));
}

/**
 * Run a mutation under one operation ID, retrying transport failures (and the web proxy's 502/503/504 while the
 * session daemon restarts) with the same ID, so the daemon admits it at most once. Other failures are final.
 */
export async function withOperationRetry<T>(operation: (operationId: string) => Promise<T>, options: { attempts?: number; delayMs?: number } = {}): Promise<T> {
  const operationId = newOperationId();
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(operationId);
    } catch (error) {
      if (attempt >= attempts || !isRetryableOperationFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, (options.delayMs ?? 500) * attempt));
    }
  }
}
