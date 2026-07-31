import { describe, expect, it, vi } from "vitest";
import { CodeViewer } from "./CodeViewer";

describe("CodeViewer editing", () => {
  it("saves the current editor document when editable", () => {
    const onSave = vi.fn<(content: string) => void>();
    const viewer = new CodeViewer();
    viewer.content = "old";
    viewer.editable = true;
    viewer.onSave = onSave;
    Reflect.set(viewer, "view", { state: { doc: { toString: () => "changed" } } });

    viewer.save();

    expect(viewer.getContent()).toBe("changed");
    expect(onSave).toHaveBeenCalledWith("changed");
  });

  it("does not save from a read-only viewer", () => {
    const onSave = vi.fn<(content: string) => void>();
    const viewer = new CodeViewer();
    viewer.content = "unchanged";
    viewer.onSave = onSave;

    viewer.save();

    expect(onSave).not.toHaveBeenCalled();
  });
});
