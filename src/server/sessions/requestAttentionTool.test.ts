import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ASK_USER_TEXT_MAX_LENGTH } from "../../shared/apiTypes.js";
import { stubExtensionToolContext } from "./piSessionService.testSupport.js";
import { createRequestAttentionToolDefinition } from "./requestAttentionTool.js";

const ctx = stubExtensionToolContext({ sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined } });

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

function tool() {
  const requestAttention = vi.fn((_sessionId: string, reason: string) => ({ id: "attention-1", reason }));
  return { requestAttention, tool: createRequestAttentionToolDefinition({ requestAttention }) };
}

describe("createRequestAttentionToolDefinition", () => {
  it("advertises a non-waiting call for needing the owner without a decision, steering decisions to ask_user", () => {
    const { tool: definition } = tool();
    const advertised = [definition.description, definition.promptSnippet, ...(definition.promptGuidelines ?? [])].join("\n");

    expect(definition.name).toBe("request_attention");
    expect(definition.exposure).toBe("model-only");
    expect(advertised).toContain("returns immediately");
    expect(advertised).toContain("ask_user");
    expect(advertised).toMatch(/review/);
    expect(advertised).toMatch(/login or credential/);
    expect(advertised).toMatch(/blocked/);
    expect(advertised).toMatch(/routine progress/);
    expect(advertised).toContain("without reading the Chat");
  });

  it("records a trimmed, length-capped reason for the calling session and returns without waiting", async () => {
    const { tool: definition, requestAttention } = tool();

    const result = await definition.execute("call-1", { reason: `  ${"x".repeat(ASK_USER_TEXT_MAX_LENGTH + 50)}  ` }, undefined, undefined, ctx);

    expect(requestAttention).toHaveBeenCalledExactlyOnceWith("session-1", "x".repeat(ASK_USER_TEXT_MAX_LENGTH));
    expect(result.details).toEqual({ request: { id: "attention-1", reason: "x".repeat(ASK_USER_TEXT_MAX_LENGTH) }, sessionId: "session-1" });
    expect(firstText(result.content)).toMatch(/does not wait/);
  });

  it("rejects a blank reason so the model writes one", async () => {
    const { tool: definition, requestAttention } = tool();

    await expect(definition.execute("call-1", { reason: "   " }, undefined, undefined, ctx)).rejects.toThrow("reason");
    expect(requestAttention).not.toHaveBeenCalled();
  });
});
