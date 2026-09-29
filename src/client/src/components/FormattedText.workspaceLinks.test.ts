// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { FormattedText } from "./FormattedText";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

function dispatchClick(view: FormattedText, anchor: HTMLAnchorElement, options: MouseEventInit = {}): boolean {
  let intercepted = false;
  // Observe the component's decision, then suppress the DOM harness's native navigation.
  view.addEventListener("click", (event) => {
    intercepted = event.defaultPrevented;
    event.preventDefault();
  }, { once: true });
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ...options }));
  return intercepted;
}

async function setup(destination = "report.txt", machineId = "remote") {
  const view = new FormattedText();
  view.workspaceContext = { machineId, projectId: "p", workspaceId: "w", root: "/work" };
  view.text = `[**file**](${destination})`;
  document.body.append(view);
  await view.updateComplete;
  const anchor = view.renderRoot.querySelector("a");
  if (!anchor) throw new Error("Missing link");
  return { view, anchor };
}

it("opens recognized files through a cancelable host request, retaining the download href", async () => {
  const { view, anchor } = await setup();
  const listener = vi.fn((event: Event) => { event.preventDefault(); });
  document.body.addEventListener("workspace-file-open", listener, { once: true });
  const click = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
  const label = anchor.querySelector("strong");
  if (label === null) throw new Error("Missing link label");
  label.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
  expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: { ...view.workspaceContext, path: "report.txt" } });
  expect(anchor.href).toContain("download=1");
});

it.each(["./src/client/src/formatting/markdown.ts", "././src//client/./src/formatting/markdown.ts"])("opens %s with the server's canonical content identity", async (destination) => {
  const { view, anchor } = await setup(destination);
  const listener = vi.fn((event: Event) => { event.preventDefault(); });
  view.addEventListener("workspace-file-open", listener);
  expect(dispatchClick(view, anchor)).toBe(true);
  const path = "src/client/src/formatting/markdown.ts";
  expect(listener).toHaveBeenCalledOnce();
  expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: { ...view.workspaceContext, path } });
  expect(new URL(anchor.href).searchParams.get("path")).toBe(path);
});

it("leaves the native download when no host accepts the request", async () => {
  const { view, anchor } = await setup();
  expect(dispatchClick(view, anchor)).toBe(false);
});

it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])("leaves modified clicks native: %j", async (options) => {
  const { view, anchor } = await setup();
  const listener = vi.fn();
  view.addEventListener("workspace-file-open", listener);
  expect(dispatchClick(view, anchor, options)).toBe(false);
  expect(listener).not.toHaveBeenCalled();
});

it("leaves explicit new-tab links native", async () => {
  const { view, anchor } = await setup();
  anchor.target = "_blank";
  const listener = vi.fn();
  view.addEventListener("workspace-file-open", listener);
  expect(dispatchClick(view, anchor)).toBe(false);
  expect(listener).not.toHaveBeenCalled();
});

it("asks the host to open a link outside the Chat folder by its absolute path", async () => {
  const { view, anchor } = await setup("../sibling/src/a.ts");
  const inside = vi.fn();
  const outside = vi.fn((event: Event) => { event.preventDefault(); });
  view.addEventListener("workspace-file-open", inside);
  view.addEventListener("outside-file-open", outside);
  expect(dispatchClick(view, anchor)).toBe(true);
  expect(inside).not.toHaveBeenCalled();
  expect(outside.mock.calls[0]?.[0]).toMatchObject({ detail: { machineId: "remote", path: "/sibling/src/a.ts" } });
});

it.each([["page.html", "/work/page.html"], ["../atelier/index.HTM", "/atelier/index.HTM"]])("asks the macOS app to open local HTML %s in the browser", async (destination, absolute) => {
  const openLocalFile = vi.fn(() => Promise.resolve(true));
  Object.defineProperty(window, "piWebNative", { configurable: true, value: { pickDirectory: vi.fn(), openLocalFile } });
  try {
    const listener = vi.fn();
    const local = await setup(destination, "local");
    local.view.addEventListener("workspace-file-open", listener);
    local.view.addEventListener("outside-file-open", listener);
    expect(dispatchClick(local.view, local.anchor)).toBe(true);
    expect(openLocalFile).toHaveBeenCalledWith(absolute);
    expect(listener).not.toHaveBeenCalled();
    const remote = await setup(destination);
    remote.view.addEventListener("workspace-file-open", listener);
    remote.view.addEventListener("outside-file-open", listener);
    dispatchClick(remote.view, remote.anchor);
    expect(openLocalFile).toHaveBeenCalledTimes(1);
  } finally {
    Reflect.deleteProperty(window, "piWebNative");
  }
});

it("keeps local HTML in the Files pane outside the macOS app", async () => {
  const { view, anchor } = await setup("page.html", "local");
  const listener = vi.fn((event: Event) => { event.preventDefault(); });
  view.addEventListener("workspace-file-open", listener);
  expect(dispatchClick(view, anchor)).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
});
