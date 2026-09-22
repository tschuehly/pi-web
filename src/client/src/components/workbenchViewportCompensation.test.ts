// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { ActionPalette } from "./ActionPalette";
import { AuthDialog } from "./AuthDialog";
import { CommandPicker } from "./CommandPicker";
import { MachineDialog } from "./MachineDialog";
import { ModalSurface } from "./ModalSurface";
import { ModelPicker } from "./ModelPicker";
import { ProjectDialog } from "./ProjectDialog";
import { PromptEditor, promptEditorMaximumHeight } from "./PromptEditor";
import { SessionTreeNavigator } from "./SessionTreeNavigator";
import { WorkbenchApp } from "./WorkbenchApp";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";

const viewportHeight = "var(--pi-workbench-viewport-height, 100vh)";
const viewportWidth = "var(--pi-workbench-viewport-width, 100vw)";

describe("Workbench zoom-compensated viewport contracts", () => {
  it("defines inherited compensated viewport dimensions on the Workbench host", () => {
    const hostRule = rule(WorkbenchApp.styles, ":host");
    expect(hostRule).toContain("--pi-workbench-viewport-height: calc(100dvh / var(--pi-interface-scale, 1))");
    expect(hostRule).toContain("--pi-workbench-viewport-width: calc(100dvw / var(--pi-interface-scale, 1))");
    expect(hostRule).toContain("height: var(--pi-workbench-viewport-height)");
  });

  it("constrains the shared modal surface while preserving the legacy 100% fallback", () => {
    expect(rule(ModalSurface.styles, ":host")).toContain("height: var(--pi-workbench-viewport-height, 100%)");
  });

  it.each([
    ["ModelPicker", ModelPicker.styles],
    ["CommandPicker", CommandPicker.styles],
    ["AuthDialog", AuthDialog.styles],
  ])("compensates %s card width and height", (_name, styles) => {
    const modalRule = rule(styles, "modal-surface");
    expect(modalRule).toContain(viewportWidth);
    expect(modalRule).toContain(viewportHeight);
  });

  it("compensates ActionPalette placement, width, and height", () => {
    const modalRule = rule(ActionPalette.styles, "modal-surface");
    expect(modalRule).toContain(viewportWidth);
    expect(modalRule).toContain(viewportHeight);
    expect(modalRule).toContain("var(--palette-top)");
    expect(modalRule).toContain("var(--palette-bottom)");
  });

  it.each([
    ["ProjectDialog", ProjectDialog.styles],
    ["MachineDialog", MachineDialog.styles],
  ])("compensates %s top placement, width, and height", (_name, styles) => {
    const modalRule = rule(styles, "modal-surface");
    expect(modalRule).toContain("--dialog-top:");
    expect(modalRule).toContain(viewportWidth);
    expect(modalRule).toContain("var(--pi-workbench-viewport-height, calc(100vh - 40px + var(--dialog-top)))");
    expect(modalRule).toContain("var(--dialog-top)");
  });

  it("keeps ProjectDialog content independently scrollable", () => {
    expect(rule(ProjectDialog.styles, ".body")).toContain("overflow: auto");
  });

  it("compensates the full-height SessionTreeNavigator", () => {
    const modalRule = rule(SessionTreeNavigator.styles, "modal-surface");
    expect(modalRule).toContain("--modal-surface-height: var(--pi-workbench-viewport-height, 100dvh)");
    expect(modalRule).toContain("--modal-surface-max-height: var(--pi-workbench-viewport-height, 100dvh)");
  });

  it("compensates the WorkstreamContextDrawer sheet height", () => {
    expect(rule(WorkstreamContextDrawer.styles, ".sheet")).toContain(`max-height: calc(${viewportHeight} - 56px)`);
  });

  it("bounds the whole PromptEditor against half the compensated viewport", () => {
    const automaticRule = rule(PromptEditor.styles, "textarea, .markdown-editor .cm-editor");
    const manualRule = rule(PromptEditor.styles, ".markdown-editor-manual-height .cm-editor");
    expect(automaticRule).toContain("max-height: min(220px, var(--prompt-editor-maximum-height, 220px))");
    expect(manualRule).toContain("height: var(--prompt-editor-manual-height)");
    expect(manualRule).toContain("max-height: var(--prompt-editor-maximum-height)");
    expect(promptEditorMaximumHeight(1_000, 1.25, 100)).toBe(300);
  });
});

function rule(styles: unknown, selector: string): string {
  const text = styleText(styles);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(text)?.[1] ?? "";
}

function styleText(styles: unknown): string {
  if (Array.isArray(styles)) return styles.map(styleText).join("\n");
  if (typeof styles === "object" && styles !== null && "cssText" in styles && typeof styles.cssText === "string") return styles.cssText;
  return "";
}
