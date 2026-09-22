import { describe, expect, it } from "vitest";
import { sessionTitle, shortSessionId } from "./sessionLabels";

describe("shortSessionId", () => {
  it("uses the random-looking suffix of UUIDv7 session ids", () => {
    expect(shortSessionId("019f22c5-d53e-7489-997f-fce1e570a202")).toBe("e570a202");
  });

  it("keeps short ids intact", () => {
    expect(shortSessionId("abc123")).toBe("abc123");
  });
});

describe("sessionTitle", () => {
  const base = { id: "019f22c5-d53e-7489-997f-fce1e570a202", firstMessage: "Initial prompt" };

  it("prefers and trims the session name", () => {
    expect(sessionTitle({ ...base, name: "  Named Chat  " })).toBe("Named Chat");
  });

  it("falls back to the trimmed first message when the name is whitespace", () => {
    expect(sessionTitle({ ...base, name: " \n ", firstMessage: "  Initial prompt  " })).toBe("Initial prompt");
  });

  it("uses the short id for a brand-new or whitespace-only session", () => {
    expect(sessionTitle({ ...base, name: "  ", firstMessage: " \n " })).toBe("e570a202");
  });
});
