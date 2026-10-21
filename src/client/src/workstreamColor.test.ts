import { describe, expect, it, vi } from "vitest";
import { WORKSTREAM_PALETTE, WORKSTREAM_TINT_PERCENTAGES, WorkstreamColorController, setWorkstreamColorOrder, workstreamAccentColor, workstreamMonogram, workstreamPaletteIndex } from "./workstreamColor";

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
  const open = (id: string, createdAt: string) => ({ id, createdAt });

  it("assigns palette entries to open Workstreams oldest first", () => {
    setWorkstreamColorOrder([open("ws-c", "2026-03-01T00:00:00Z"), open("ws-a", "2026-01-01T00:00:00Z"), open("ws-b", "2026-02-01T00:00:00Z")]);
    expect(["ws-a", "ws-b", "ws-c"].map(workstreamPaletteIndex)).toEqual([0, 1, 2]);
    const [light, dark] = WORKSTREAM_PALETTE[1];
    expect(workstreamAccentColor("ws-b")).toBe(`light-dark(${light}, ${dark})`);
  });

  it("gives the two formerly colliding Workstreams different colours", () => {
    setWorkstreamColorOrder([open("ws-pi-workbench-ui-dogfooding-20260921", "2026-09-21T08:00:00Z"), open("ws-studio-evidence-guided-improvement-20260831", "2026-08-31T08:00:00Z")]);
    expect(workstreamAccentColor("ws-pi-workbench-ui-dogfooding-20260921")).not.toBe(workstreamAccentColor("ws-studio-evidence-guided-improvement-20260831"));
  });

  it("keeps every open Workstream distinct up to the palette size, then wraps", () => {
    const ids = Array.from({ length: WORKSTREAM_PALETTE.length + 2 }, (_, index) => `ws-${String(index).padStart(2, "0")}`);
    setWorkstreamColorOrder(ids.map((id, index) => open(id, `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`)));
    const colors = ids.map(workstreamAccentColor);
    expect(new Set(colors.slice(0, WORKSTREAM_PALETTE.length)).size).toBe(WORKSTREAM_PALETTE.length);
    expect(colors[WORKSTREAM_PALETTE.length]).toBe(colors[0]);
    expect(colors[WORKSTREAM_PALETTE.length + 1]).toBe(colors[1]);
  });

  it("falls back to a stable palette entry for Workstreams outside the open list", () => {
    setWorkstreamColorOrder([]);
    for (const id of ["a", "workstream-abc123", "", "🎨", "x".repeat(500)]) {
      const index = workstreamPaletteIndex(id);
      expect(index).toBe(workstreamPaletteIndex(id));
      expect(WORKSTREAM_PALETTE[index]).toBeDefined();
    }
  });

  it("re-renders controller hosts only when the order changes", () => {
    const host = { addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn(), updateComplete: Promise.resolve(true) };
    const controller = new WorkstreamColorController(host);
    controller.hostConnected();
    setWorkstreamColorOrder([open("ws-1", "2026-01-01T00:00:00Z")]);
    setWorkstreamColorOrder([open("ws-1", "2026-01-01T00:00:00Z")]);
    controller.hostDisconnected();
    setWorkstreamColorOrder([]);
    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps full-surface identity tint strengths explicit", () => {
    expect(WORKSTREAM_TINT_PERCENTAGES).toEqual({ mark: 30, tab: 12, tabSelected: 26 });
  });
});
