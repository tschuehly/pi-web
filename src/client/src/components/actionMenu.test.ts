import { afterEach, describe, expect, it, vi } from "vitest";
import { actionMenuPanelStyle } from "./actionMenu";

describe("actionMenuPanelStyle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the visible viewport while the on-screen keyboard is open", () => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800, visualViewport: { offsetLeft: 0, offsetTop: 50, width: 400, height: 350 } });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    const target = new FakeHTMLElement({ top: 300, right: 390, bottom: 336, left: 354 });
    expect(actionMenuPanelStyle(target, { constrainTo: "viewport" })).toBe("bottom: 500px; max-height: 250px; right: 10px; max-width: 390px;");
  });

  it.each([
    { top: -100, bottom: -64, expected: "top: 50px; max-height: 350px; right: 10px; max-width: 390px;" },
    { top: 700, bottom: 736, expected: "bottom: 400px; max-height: 350px; right: 10px; max-width: 390px;" },
  ])("keeps menus inside the visible viewport for an offscreen trigger at $top", ({ top, bottom, expected }) => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800, visualViewport: { offsetLeft: 0, offsetTop: 50, width: 400, height: 350 } });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    const target = new FakeHTMLElement({ top, right: 390, bottom, left: 354 });
    expect(actionMenuPanelStyle(target, { constrainTo: "viewport" })).toBe(expected);
  });

  it("can constrain menus to the viewport for compact shadow-root controls", () => {
    vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800 });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    const target = new FakeHTMLElement({ top: 10, right: 390, bottom: 46, left: 354 });

    expect(actionMenuPanelStyle(target, { constrainTo: "viewport" })).toBe("top: 46px; max-height: 754px; right: 10px; max-width: 390px;");
  });
});

class FakeHTMLElement extends EventTarget {
  constructor(private readonly rect: { top: number; right: number; bottom: number; left: number }) {
    super();
  }

  getBoundingClientRect(): { top: number; right: number; bottom: number; left: number } {
    return this.rect;
  }
}
