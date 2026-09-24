import { describe, expect, it, vi } from "vitest";
import { imageReferenceInsertion, isLeadingKnownCommandDraft, PromptEditor, sanitizeDraftImageReferences } from "./components/PromptEditor";
import { removeImageReferenceTokensFromText } from "../../shared/promptAttachments";
import { clearStagedAttachments, loadStagedAttachmentDraft, moveStagedAttachments } from "./promptAttachmentStaging";
import { capturePromptAttachments, DEFAULT_FILE_MIME_TYPE, effectivePromptAttachmentDelivery, READ_FAILURE_MESSAGE, type CapturableFile } from "./promptAttachmentCapture";
import { templateEventHandlerAfterMarker, templateEventHandlerAfterValue } from "./templateInspection.testSupport";

function file(name: string, type: string, size = 10): CapturableFile {
  return { name, type, size };
}

describe("capturePromptAttachments", () => {
  it("reads supported images as native inline image attachments", async () => {
    const result = await capturePromptAttachments(
      [file("shot.png", "image/png"), file("pic.webp", "image/webp")],
      (f) => Promise.resolve(`data-for-${f.name}`),
    );

    expect(result.error).toBeUndefined();
    expect(result.attachments).toEqual([
      { kind: "image", name: "shot.png", mimeType: "image/png", data: "data-for-shot.png", size: 10 },
      { kind: "image", name: "pic.webp", mimeType: "image/webp", data: "data-for-pic.webp", size: 10 },
    ]);
  });

  it("captures generic files with their browser MIME type", async () => {
    const result = await capturePromptAttachments(
      [file("report.pdf", "application/pdf", 1234), file("vector.svg", "image/svg+xml")],
      (f) => Promise.resolve(`data-for-${f.name}`),
    );

    expect(result.error).toBeUndefined();
    expect(result.attachments).toEqual([
      { kind: "file", name: "report.pdf", mimeType: "application/pdf", data: "data-for-report.pdf", size: 1234 },
      { kind: "file", name: "vector.svg", mimeType: "image/svg+xml", data: "data-for-vector.svg", size: 10 },
    ]);
  });

  it("uses application/octet-stream when the browser does not provide a MIME type", async () => {
    const result = await capturePromptAttachments([file("archive", "")], () => Promise.resolve("x"));

    expect(result.attachments[0]).toMatchObject({ kind: "file", name: "archive", mimeType: DEFAULT_FILE_MIME_TYPE });
  });

  it("derives fallback names for unnamed pasted attachments", async () => {
    const result = await capturePromptAttachments(
      [file("", "image/jpeg"), file("", "application/pdf")],
      () => Promise.resolve("x"),
    );

    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["pasted-image.jpg", "pasted-file.bin"]);
  });

  it("reports a read failure without dropping other attachments", async () => {
    const result = await capturePromptAttachments(
      [file("bad.png", "image/png"), file("good.txt", "text/plain")],
      (f) => f.name === "bad.png" ? Promise.reject(new Error("boom")) : Promise.resolve("ok"),
    );

    expect(result.error).toBe(READ_FAILURE_MESSAGE);
    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["good.txt"]);
  });

  it("returns no attachments and no error for an empty batch", async () => {
    const result = await capturePromptAttachments([], () => Promise.resolve("x"));
    expect(result).toEqual({ attachments: [] });
  });
});

describe("effectivePromptAttachmentDelivery", () => {
  it("preserves inline delivery when all pending attachments are supported images", () => {
    expect(effectivePromptAttachmentDelivery("inline", [{ kind: "image", mimeType: "image/png" }])).toBe("inline");
  });

  it("preserves an explicit folder preference for supported images", () => {
    expect(effectivePromptAttachmentDelivery("folder", [{ kind: "image", mimeType: "image/png" }])).toBe("folder");
  });

  it("forces folder delivery when any attachment is a generic file", () => {
    expect(effectivePromptAttachmentDelivery("inline", [
      { kind: "image", mimeType: "image/png" },
      { kind: "file", mimeType: "application/pdf" },
    ])).toBe("folder");
  });
});

describe("prompt image references", () => {
  it("inserts a reserved batch at the cursor without joining surrounding words", () => {
    expect(imageReferenceInsertion("beforeafter", 6, ["[PIC_1]", "[PIC_2]"])).toBe(" [PIC_1] [PIC_2] ");
  });

  it("recognizes only known leading commands, templates, and skills", () => {
    const known = new Set(["extension-command", "template-name", "skill:skill-name"]);
    expect(isLeadingKnownCommandDraft("/extension-command arg", known)).toBe(true);
    expect(isLeadingKnownCommandDraft("/template-name arg", known)).toBe(true);
    expect(isLeadingKnownCommandDraft("/skill:skill-name arg", known)).toBe(true);
    expect(isLeadingKnownCommandDraft("/Users/thomas/project screenshot", known)).toBe(false);
  });

  it("normalizes token-removal whitespace while preserving numbered gaps", () => {
    expect(removeImageReferenceTokensFromText("[PIC_1] compare [PIC_1] with [PIC_3]", ["[PIC_1]"])).toBe("compare with [PIC_3]");
  });

  it("inserts a reserved batch in one editor transaction at the requested cursor", () => {
    const editor = new PromptEditor();
    const dispatch = vi.fn();
    setPromptEditorPrivate(editor, "draft", "abcdef");
    setPromptEditorPrivate(editor, "editor", { dispatch });
    const insert: unknown = Reflect.get(editor, "insertImageReferenceTokens");
    if (typeof insert !== "function") throw new Error("PromptEditor insertion unavailable");

    Reflect.apply(insert, editor, [["[PIC_1]", "[PIC_2]"], 3]);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ changes: { from: 3, to: 3, insert: " [PIC_1] [PIC_2] " } }));
  });

  it("removes dangling restored references but preserves staged mappings", () => {
    expect(sanitizeDraftImageReferences("keep [PIC_2], drop [PIC_1] [PIC_3]", [
      { kind: "image", reference: "[PIC_2]" },
    ])).toBe("keep [PIC_2], drop");
    expect(sanitizeDraftImageReferences("reading [PIC_4]", [], ["[PIC_4]"])).toBe("reading [PIC_4]");
    expect(sanitizeDraftImageReferences("reload [PIC_9]", [])).toBe("reload");
  });
});

describe("PromptEditor attachment wiring", () => {
  // TemplateResult handler extraction (via the shared escape hatch) verifies the paste/remove/send
  // event wiring here; this repo runs Vitest without a DOM environment, so a full custom-element +
  // FileReader render harness would add disproportionate setup for this narrow wiring check. Each
  // assertion observes a component effect (the injected `onSend` callback and its captured
  // attachments), not Lit template internals. Rendered content/error text is covered at the pure
  // layer by the `capturePromptAttachments` tests above.
  it.each([
    ["extension command", "/extension-command --flag", "extension-command"],
    ["template", "/template-name exact args", "template-name"],
    ["skill", "/skill:skill-name exact args", "skill:skill-name"],
  ])("stages an image without mutating %s text", async (_label, draft, commandName) => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", draft);
    setPromptEditorPrivate(editor, "knownCommandNames", new Set([commandName]));
    const restoreFileReader = installFileReaderStub([{ kind: "load", result: "data:image/png;base64,SU1BR0U=" }]);
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      await flushMicrotasks();
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      await flushMicrotasks();
      expect(onSend).toHaveBeenCalledWith(draft, undefined, [expect.objectContaining({ reference: "[PIC_1]" })], "inline", undefined);
    } finally {
      restoreFileReader();
    }
  });

  it.each([
    ["builtin", "model"],
    ["extension", "extension-command"],
    ["template", "template-name"],
    ["skill", "skill:skill-name"],
  ])("forwards staged tokens immediately when prose transitions to a known %s command", async (_kind, commandName) => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "describe this");
    const restoreFileReader = installFileReaderStub([{ kind: "load", result: "data:image/png;base64,SU1BR0U=" }]);
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      await flushMicrotasks();
      expect(Reflect.get(editor, "draft")).toBe("describe this [PIC_1] ");

      editor.replaceText(`/${commandName} ${String(Reflect.get(editor, "draft"))}`);
      setPromptEditorPrivate(editor, "knownCommandNames", new Set([commandName]));
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      await flushMicrotasks();

      expect(onSend).toHaveBeenCalledWith(`/${commandName} describe this [PIC_1]`, undefined, [expect.objectContaining({ reference: "[PIC_1]" })], "inline", undefined);
    } finally {
      restoreFileReader();
    }
  });

  it("does not let a stalled command catalog block attachment capture or send", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "commandCatalogRequest", new Promise(() => undefined));
    setPromptEditorPrivate(editor, "draft", "/stalled-command inspect");
    const restoreFileReader = installFileReaderStub([{ kind: "load", result: "data:image/png;base64,SU1BR0U=" }]);
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      await flushMicrotasks();
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      expect(onSend).toHaveBeenCalledWith("/stalled-command inspect [PIC_1]", undefined, [expect.objectContaining({ reference: "[PIC_1]" })], "inline", undefined);
    } finally {
      restoreFileReader();
    }
  });

  it("does not resend or alter delivery when a delayed command catalog arrives", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    let resolveCatalog: (commands: { name: string; source: "extension" }[]) => void = () => undefined;
    setPromptEditorPrivate(editor, "commandCatalogRequest", new Promise((resolve) => { resolveCatalog = resolve; }));
    setPromptEditorPrivate(editor, "draft", "/late-command inspect [PIC_1]");
    setPromptEditorPrivate(editor, "attachments", [{ id: "attachment-1", kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: "SU1BR0U=" }]);

    templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
    expect(onSend).toHaveBeenCalledWith("/late-command inspect [PIC_1]", undefined, [expect.objectContaining({ reference: "[PIC_1]" })], "inline", undefined);

    resolveCatalog([{ name: "late-command", source: "extension" }]);
    await flushMicrotasks();
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("retains staged tokens when prose transitions to an absolute-path sentence before send", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "describe this");
    const restoreFileReader = installFileReaderStub([{ kind: "load", result: "data:image/png;base64,SU1BR0U=" }]);
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      await flushMicrotasks();
      editor.replaceText(`/Users/thomas/project ${String(Reflect.get(editor, "draft"))}`);
      setPromptEditorPrivate(editor, "knownCommandNames", new Set(["model"]));
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      await flushMicrotasks();

      expect(onSend.mock.calls[0]?.[0]).toBe("/Users/thomas/project describe this [PIC_1]");
    } finally {
      restoreFileReader();
    }
  });

  it("treats an ordinary absolute-path sentence as prose and inserts its image token", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "/Users/thomas/project screenshot");
    setPromptEditorPrivate(editor, "knownCommandNames", new Set(["extension-command"]));
    const restoreFileReader = installFileReaderStub([{ kind: "load", result: "data:image/png;base64,SU1BR0U=" }]);
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      await flushMicrotasks();
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      await flushMicrotasks();
      expect(onSend.mock.calls[0]?.[0]).toBe("/Users/thomas/project screenshot [PIC_1]");
    } finally {
      restoreFileReader();
    }
  });

  it("captures pasted files, strips data URL prefixes, and keeps successful reads when others fail", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "inspect attachments");
    const restoreFileReader = installFileReaderStub([
      { kind: "load", result: "data:image/png;base64,UE5H" },
      { kind: "error", error: new DOMException("File unavailable", "NotReadableError") },
    ]);

    try {
      const paste = templateEventHandlerAfterMarker(editor.render(), "@paste=");
      const pasteEvent = pasteEventWithFiles([
        new File(["png"], "shot.png", { type: "image/png" }),
        new File(["pdf"], "report.pdf", { type: "application/pdf" }),
      ]);
      const preventDefault = vi.spyOn(pasteEvent, "preventDefault");

      paste(pasteEvent);
      await flushMicrotasks();

      expect(preventDefault).toHaveBeenCalledOnce();

      const send = templateEventHandlerAfterMarker(editor.render(), "send-button");
      send(new Event("click"));

      // report.pdf failed to read, so only the successfully-read image survives to onSend — proving
      // the paste is wired to capture, the data URL prefix is stripped, and a failed read does not
      // drop the other attachment.
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith("inspect attachments [PIC_1]", undefined, [
        { kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: "UE5H", name: "shot.png" },
      ], "inline", undefined);
    } finally {
      restoreFileReader();
    }
  });

  it("keeps duplicate images distinct and reserves concurrent paste references in invocation order", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    const restoreFileReader = installFileReaderStub([
      { kind: "load", result: "data:image/png;base64,RklSU1Q=" },
      { kind: "load", result: "data:image/png;base64,U0VDT05E" },
      { kind: "load", result: "data:text/plain;base64,RklMRQ==" },
    ]);
    try {
      const paste = templateEventHandlerAfterMarker(editor.render(), "@paste=");
      paste(pasteEventWithFiles([new File(["same"], "same.png", { type: "image/png" })]));
      paste(pasteEventWithFiles([new File(["same"], "same.png", { type: "image/png" })]));
      paste(pasteEventWithFiles([new File(["file"], "notes.txt", { type: "text/plain" })]));
      await flushMicrotasks();
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));

      expect(onSend).toHaveBeenCalledWith("[PIC_1] [PIC_2]", undefined, [
        expect.objectContaining({ reference: "[PIC_1]", name: "same.png", data: "RklSU1Q=" }),
        expect.objectContaining({ reference: "[PIC_2]", name: "same.png", data: "U0VDT05E" }),
        expect.objectContaining({ kind: "file", name: "notes.txt", data: "RklMRQ==" }),
      ], "folder", ".pi-web/attachments");
    } finally {
      restoreFileReader();
    }
  });

  it("preserves invocation order when reads finish out of order", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    const readers = installControlledFileReaderStub();
    try {
      const paste = templateEventHandlerAfterMarker(editor.render(), "@paste=");
      paste(pasteEventWithFiles([new File(["first"], "first.png", { type: "image/png" })]));
      paste(pasteEventWithFiles([new File(["second"], "second.png", { type: "image/png" })]));
      readers.resolve(1, "data:image/png;base64,U0VDT05E");
      await flushMicrotasks();
      readers.resolve(0, "data:image/png;base64,RklSU1Q=");
      await flushMicrotasks();

      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      expect(onSend.mock.calls[0]?.[2]?.map((attachment) => attachment.kind === "image" ? attachment.reference : "file")).toEqual(["[PIC_1]", "[PIC_2]"]);
    } finally {
      readers.restore();
    }
  });

  it("does not send a dangling token while its image is still loading", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    const readers = installControlledFileReaderStub();
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      expect(onSend).not.toHaveBeenCalled();

      readers.resolve(0, "data:image/png;base64,SU1BR0U=");
      await flushMicrotasks();
      expect(Reflect.get(editor, "attachmentError")).toBeUndefined();
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));
      expect(onSend).toHaveBeenCalledWith("[PIC_1]", undefined, [expect.objectContaining({ reference: "[PIC_1]" })], "inline", undefined);
    } finally {
      readers.restore();
    }
  });

  it("does not clear an earlier concurrent read failure when a later batch succeeds", async () => {
    const editor = new PromptEditor();
    const readers = installControlledFileReaderStub();
    try {
      const paste = templateEventHandlerAfterMarker(editor.render(), "@paste=");
      paste(pasteEventWithFiles([new File(["bad"], "bad.png", { type: "image/png" })]));
      paste(pasteEventWithFiles([new File(["good"], "good.png", { type: "image/png" })]));
      readers.reject(0, new DOMException("unreadable", "NotReadableError"));
      await flushMicrotasks();
      expect(Reflect.get(editor, "attachmentError")).toBe(READ_FAILURE_MESSAGE);

      readers.resolve(1, "data:image/png;base64,R09PRA==");
      await flushMicrotasks();
      expect(Reflect.get(editor, "attachmentError")).toBe(READ_FAILURE_MESSAGE);
    } finally {
      readers.restore();
    }
  });

  it("drops stale read completions after the draft is reset", async () => {
    const editor = new PromptEditor();
    editor.sessionId = "reset-session";
    const readers = installControlledFileReaderStub();
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      const reset: unknown = Reflect.get(editor, "resetComposer");
      if (typeof reset !== "function") throw new Error("PromptEditor reset unavailable");
      Reflect.apply(reset, editor, []);
      readers.resolve(0, "data:image/png;base64,SU1BR0U=");
      await flushMicrotasks();

      expect(Reflect.get(editor, "draft")).toBe("");
      expect(Reflect.get(editor, "attachments")).toEqual([]);
      expect(loadStagedAttachmentDraft("local:reset-session")).toMatchObject({ attachments: [], pendingImageReferences: [], generation: 1 });
    } finally {
      clearStagedAttachments("local:reset-session");
      readers.restore();
    }
  });

  it("lands an in-flight read after a temp-to-real key move and session switch", async () => {
    const editor = new PromptEditor();
    editor.sessionId = "temp-session";
    const readers = installControlledFileReaderStub();
    try {
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["image"], "image.png", { type: "image/png" })]));
      moveStagedAttachments("local:temp-session", "local:real-session");
      editor.sessionId = "real-session";
      const willUpdate: unknown = Reflect.get(editor, "willUpdate");
      if (typeof willUpdate !== "function") throw new Error("PromptEditor session switch unavailable");
      Reflect.apply(willUpdate, editor, [new Map([["sessionId", "temp-session"]])]);
      readers.resolve(0, "data:image/png;base64,SU1BR0U=");
      await flushMicrotasks();

      expect(loadStagedAttachmentDraft("local:temp-session").attachments).toEqual([]);
      expect(loadStagedAttachmentDraft("local:real-session").attachments).toEqual([expect.objectContaining({ reference: "[PIC_1]" })]);
    } finally {
      clearStagedAttachments("local:temp-session");
      clearStagedAttachments("local:real-session");
      readers.restore();
    }
  });

  it("removes every matching image token with its preview while preserving reference gaps", () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "[PIC_1] compare [PIC_1] with [PIC_2]");
    setPromptEditorPrivate(editor, "attachments", [
      { id: "attachment-1", kind: "image", reference: "[PIC_1]", name: "first.png", mimeType: "image/png", data: "RklSU1Q=", size: 5 },
      { id: "attachment-2", kind: "image", reference: "[PIC_2]", name: "second.png", mimeType: "image/png", data: "U0VDT05E", size: 6 },
    ]);

    templateEventHandlerAfterValue(editor.render(), "Remove [PIC_1] image first.png", "@click=")(new Event("click"));
    templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));

    expect(onSend).toHaveBeenCalledWith("compare with [PIC_2]", undefined, [
      expect.objectContaining({ reference: "[PIC_2]" }),
    ], "inline", undefined);
  });

  it("preserves the reference gap when an image is removed and another is pasted", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "[PIC_1] [PIC_2]");
    setPromptEditorPrivate(editor, "nextImageReference", 3);
    setPromptEditorPrivate(editor, "attachmentSeq", 2);
    setPromptEditorPrivate(editor, "attachments", [
      { id: "attachment-1", kind: "image", reference: "[PIC_1]", name: "first.png", mimeType: "image/png", data: "RklSU1Q=", size: 5 },
      { id: "attachment-2", kind: "image", reference: "[PIC_2]", name: "second.png", mimeType: "image/png", data: "U0VDT05E", size: 6 },
    ]);
    const restoreFileReader = installFileReaderStub([{ kind: "load", result: "data:image/png;base64,VEhJUkQ=" }]);
    try {
      templateEventHandlerAfterValue(editor.render(), "Remove [PIC_1] image first.png", "@click=")(new Event("click"));
      templateEventHandlerAfterMarker(editor.render(), "@paste=")(pasteEventWithFiles([new File(["third"], "third.png", { type: "image/png" })]));
      await flushMicrotasks();
      templateEventHandlerAfterMarker(editor.render(), "send-button")(new Event("click"));

      expect(onSend.mock.calls[0]?.[0]).toBe("[PIC_2] [PIC_3]");
      expect(onSend.mock.calls[0]?.[2]?.map((attachment) => attachment.kind === "image" ? attachment.reference : "file")).toEqual(["[PIC_2]", "[PIC_3]"]);
    } finally {
      restoreFileReader();
    }
  });

  it("removes a pending attachment chip before sending the remaining attachments", () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "please review");
    setPromptEditorPrivate(editor, "attachments", [
      { id: "attachment-1", kind: "file", name: "report.pdf", mimeType: "application/pdf", data: "UkVQT1JU", size: 6 },
      { id: "attachment-2", kind: "image", reference: "[PIC_1]", name: "shot.png", mimeType: "image/png", data: "UE5H", size: 3 },
    ]);

    const removeReport = templateEventHandlerAfterValue(editor.render(), "Remove report.pdf", "@click=");
    removeReport(new Event("click"));

    const send = templateEventHandlerAfterMarker(editor.render(), "send-button");
    send(new Event("click"));

    // onSend receives only the image, proving the remove handler dropped report.pdf while leaving
    // shot.png queued (folder delivery is not forced because no generic file remains).
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("please review", undefined, [
      { kind: "image", reference: "[PIC_1]", mimeType: "image/png", data: "UE5H", name: "shot.png" },
    ], "inline", undefined);
  });
});

type StubFileReaderOutcome =
  | { kind: "load"; result: string }
  | { kind: "error"; error: DOMException };

function setPromptEditorPrivate(editor: PromptEditor, property: string, value: unknown): void {
  if (!Reflect.set(editor, property, value)) throw new Error(`Failed to set PromptEditor ${property}`);
}

function installFileReaderStub(outcomes: StubFileReaderOutcome[]): () => void {
  const hadFileReader = Reflect.has(globalThis, "FileReader");
  const previousFileReader = Reflect.get(globalThis, "FileReader");

  class StubFileReader {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    error: DOMException | null = null;
    result: string | ArrayBuffer | null = null;

    readAsDataURL(): void {
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error("Unexpected FileReader.readAsDataURL call");
      if (outcome.kind === "error") {
        this.error = outcome.error;
        this.onerror?.();
        return;
      }
      this.result = outcome.result;
      this.onload?.();
    }
  }

  Reflect.set(globalThis, "FileReader", StubFileReader);
  return () => {
    if (hadFileReader) {
      Reflect.set(globalThis, "FileReader", previousFileReader);
      return;
    }
    Reflect.deleteProperty(globalThis, "FileReader");
  };
}


function installControlledFileReaderStub(): { resolve: (index: number, result: string) => void; reject: (index: number, error: DOMException) => void; restore: () => void } {
  const hadFileReader = Reflect.has(globalThis, "FileReader");
  const previousFileReader = Reflect.get(globalThis, "FileReader");
  const readers: { reader: ControlledFileReader }[] = [];

  class ControlledFileReader {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    error: DOMException | null = null;
    result: string | ArrayBuffer | null = null;

    readAsDataURL(): void {
      readers.push({ reader: this });
    }
  }

  Reflect.set(globalThis, "FileReader", ControlledFileReader);
  return {
    resolve: (index, result) => {
      const reader = readers[index]?.reader;
      if (reader === undefined) throw new Error(`Missing controlled FileReader ${String(index)}`);
      reader.result = result;
      reader.onload?.();
    },
    reject: (index, error) => {
      const reader = readers[index]?.reader;
      if (reader === undefined) throw new Error(`Missing controlled FileReader ${String(index)}`);
      reader.error = error;
      reader.onerror?.();
    },
    restore: () => {
      if (hadFileReader) Reflect.set(globalThis, "FileReader", previousFileReader);
      else Reflect.deleteProperty(globalThis, "FileReader");
    },
  };
}

function pasteEventWithFiles(files: readonly File[]): Event {
  const event = new Event("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  return event;
}

async function flushMicrotasks(): Promise<void> {
  for (let remaining = 0; remaining < 10; remaining += 1) await Promise.resolve();
}
