/** Rejected reuse of an operation ID for a different request. */
export class OperationPayloadMismatch extends Error {
  constructor(operationId: string) {
    super(`Operation ${operationId} was already used with a different request`);
    this.name = "OperationPayloadMismatch";
  }
}

/**
 * In-memory receipts of client operation IDs for one daemon lifetime: a retried request with the same ID and payload
 * joins the first attempt's result instead of running again; the same ID with another payload is rejected. A failed
 * attempt leaves no receipt, so its retry runs. Durable Chats also dedupe in their host, across restarts.
 * ponytail: bounded insertion-order map; legacy Chats lose receipts on a daemon restart.
 */
export class OperationReceipts<T> {
  readonly #receipts = new Map<string, { payload: string; result: Promise<T> }>();

  constructor(private readonly limit = 1000) {}

  run(scope: string, operationId: string | undefined, payload: unknown, operation: () => Promise<T>): Promise<T> {
    if (operationId === undefined) return operation();
    const key = `${scope}\0${operationId}`;
    const serialized = JSON.stringify(payload);
    const existing = this.#receipts.get(key);
    if (existing !== undefined) {
      if (existing.payload !== serialized) return Promise.reject(new OperationPayloadMismatch(operationId));
      return existing.result;
    }
    const result = operation();
    this.#receipts.set(key, { payload: serialized, result });
    result.catch(() => { if (this.#receipts.get(key)?.result === result) this.#receipts.delete(key); });
    for (const oldest of this.#receipts.keys()) {
      if (this.#receipts.size <= this.limit) break;
      this.#receipts.delete(oldest);
    }
    return result;
  }
}
