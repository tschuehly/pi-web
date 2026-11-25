import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationPayloadMismatch, OperationReceipts } from "./operationReceipts.js";

describe("OperationReceipts", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("joins a retry with the same payload, rejects another payload, and keeps a fixed-size digest, not the payload", async () => {
    const stored: unknown[] = [];
    const set = Map.prototype.set;
    vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
      stored.push(value);
      return set.call(this, key, value);
    });
    const receipts = new OperationReceipts<string>();
    const image = "A".repeat(1_000_000);
    const operation = vi.fn(() => Promise.resolve("done"));

    await expect(receipts.run("ask:s", "op-1", ["submit", { images: [{ data: image }] }], operation)).resolves.toBe("done");
    await expect(receipts.run("ask:s", "op-1", ["submit", { images: [{ data: image }] }], operation)).resolves.toBe("done");
    await expect(receipts.run("ask:s", "op-1", ["submit", { images: [] }], operation)).rejects.toThrow(OperationPayloadMismatch);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(stored)).not.toContain(image);
  });
});
