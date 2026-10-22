import { describe, expect, it } from "vitest";
import { HttpRequestError, NetworkRequestError } from "./http";
import { withOperationRetry } from "./operationRetry";

describe("withOperationRetry", () => {
  it("retries a transport failure and a proxy 502 under the same operation id", async () => {
    const ids: string[] = [];
    const failures = [new NetworkRequestError("Load failed"), new HttpRequestError("Session daemon unavailable", 502)];
    const result = await withOperationRetry((id) => {
      ids.push(id);
      const failure = failures.shift();
      return failure === undefined ? Promise.resolve("accepted") : Promise.reject(failure);
    }, { delayMs: 0 });
    expect(result).toBe("accepted");
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^op-[0-9a-f]{32}$/);
  });

  it("does not retry a refused request, and gives up after the last attempt", async () => {
    let calls = 0;
    await expect(withOperationRetry(() => { calls++; return Promise.reject(new HttpRequestError("text field must be a non-empty string", 400)); }, { delayMs: 0 })).rejects.toThrow(/non-empty/);
    expect(calls).toBe(1);
    calls = 0;
    await expect(withOperationRetry(() => { calls++; return Promise.reject(new NetworkRequestError("offline")); }, { delayMs: 0, attempts: 2 })).rejects.toThrow("offline");
    expect(calls).toBe(2);
  });

  it("gives every operation its own id", async () => {
    const ids = await Promise.all([1, 2].map(() => withOperationRetry((id) => Promise.resolve(id))));
    expect(ids[0]).not.toBe(ids[1]);
  });
});
