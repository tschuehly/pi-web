import { describe, expect, it } from "vitest";
import { WORKSTREAM_TINT_PERCENTAGES, workstreamAccentColor, workstreamHue, workstreamMonogram } from "./workstreamColor";

describe("workstreamHue", () => {
  it("is stable for the same id", () => {
    expect(workstreamHue("workstream-1")).toBe(workstreamHue("workstream-1"));
  });

  it("differs across different ids", () => {
    expect(workstreamHue("workstream-1")).not.toBe(workstreamHue("workstream-2"));
  });

  it("stays within a valid hue range", () => {
    for (const id of ["a", "workstream-abc123", "", "🎨", "x".repeat(500)]) {
      const hue = workstreamHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });
});

describe("workstreamMonogram", () => {
  it("derives a stable visible cue from one or more title words", () => {
    expect(workstreamMonogram("Pi Workbench UI")).toBe("PU");
    expect(workstreamMonogram("Launcher")).toBe("LA");
    expect(workstreamMonogram("  durable   workers  ")).toBe("DW");
    expect(workstreamMonogram("🎨 studio")).toBe("🎨S");
    expect(workstreamMonogram("   ")).toBe("WS");
  });
});

describe("workstreamAccentColor", () => {
  it("embeds the id's hue in a light-dark() color usable directly in a style attribute", () => {
    const hue = workstreamHue("workstream-1");
    expect(workstreamAccentColor("workstream-1")).toBe(`light-dark(hsl(${String(hue)}deg 70% 40%), hsl(${String(hue)}deg 65% 65%))`);
  });

  it("gives the same color for the same id across call sites", () => {
    expect(workstreamAccentColor("workstream-9")).toBe(workstreamAccentColor("workstream-9"));
  });

  it("keeps full-surface identity tint strengths explicit", () => {
    expect(WORKSTREAM_TINT_PERCENTAGES).toEqual({ row: 12, rowHover: 18, rowSelected: 22, rowSelectedHover: 28, card: 9, mark: 30, drawer: 12, drawerActive: 18 });
  });
});
