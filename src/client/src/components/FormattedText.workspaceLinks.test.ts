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

it("asks the macOS app to open a local folder in Finder, falling back to the Files pane when it is not one", async () => {
  const openLocalFile = vi.fn((path: string) => path.endsWith("Makefile") ? Promise.reject(new Error("not a folder")) : Promise.resolve(true));
  Object.defineProperty(window, "piWebNative", { configurable: true, value: { pickDirectory: vi.fn(), openLocalFile } });
  try {
    const listener = vi.fn((event: Event) => { event.preventDefault(); });
    const folder = await setup("/Users/me/shots", "local");
    folder.view.addEventListener("outside-file-open", listener);
    expect(dispatchClick(folder.view, folder.anchor)).toBe(true);
    expect(openLocalFile).toHaveBeenCalledWith("/Users/me/shots");
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();

    const file = await setup("src/Makefile", "local");
    file.view.addEventListener("workspace-file-open", listener);
    expect(dispatchClick(file.view, file.anchor)).toBe(true);
    expect(openLocalFile).toHaveBeenLastCalledWith("/work/src/Makefile");
    await vi.waitFor(() => { expect(listener).toHaveBeenCalledOnce(); });
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: { path: "src/Makefile" } });

    const text = await setup("notes.md", "local");
    text.view.addEventListener("workspace-file-open", listener);
    dispatchClick(text.view, text.anchor);
    expect(openLocalFile).toHaveBeenCalledTimes(2);
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

it("reveals a local .docx link in Finder without opening anything, while a .md link still opens the Files pane", async () => {
  const openLocalFile = vi.fn(() => Promise.resolve(true));
  const revealLocalFile = vi.fn(() => Promise.resolve(true));
  Object.defineProperty(window, "piWebNative", { configurable: true, value: { pickDirectory: vi.fn(), openLocalFile, revealLocalFile } });
  try {
    const listener = vi.fn((event: Event) => { event.preventDefault(); });
    const docx = await setup("docs/Plan.docx", "local");
    docx.view.addEventListener("workspace-file-open", listener);
    expect(dispatchClick(docx.view, docx.anchor)).toBe(true);
    expect(revealLocalFile).toHaveBeenCalledWith("/work/docs/Plan.docx");
    await Promise.resolve();
    expect(openLocalFile).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    const markdown = await setup("docs/notes.md", "local");
    markdown.view.addEventListener("workspace-file-open", listener);
    expect(dispatchClick(markdown.view, markdown.anchor)).toBe(true);
    expect(revealLocalFile).toHaveBeenCalledOnce();
    expect(openLocalFile).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: { path: "docs/notes.md" } });
  } finally {
    Reflect.deleteProperty(window, "piWebNative");
  }
});

it("opens a .docx link in the Files pane when the app cannot reveal it", async () => {
  const listener = vi.fn((event: Event) => { event.preventDefault(); });
  const remote = await setup("docs/Plan.docx");
  remote.view.addEventListener("workspace-file-open", listener);
  expect(dispatchClick(remote.view, remote.anchor)).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
});

it("adds a Show in Finder button to each local file link that reveals the file without opening it", async () => {
  const revealLocalFile = vi.fn(() => Promise.resolve(true));
  const openLocalFile = vi.fn(() => Promise.resolve(true));
  Object.defineProperty(window, "piWebNative", { configurable: true, value: { pickDirectory: vi.fn(), openLocalFile, revealLocalFile } });
  try {
    const listener = vi.fn();
    const local = await setup("../elsewhere/Plan.docx", "local");
    local.view.addEventListener("outside-file-open", listener);
    const button = local.anchor.nextElementSibling;
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing Show in Finder button");
    expect(button.getAttribute("aria-label")).toBe("Show file in Finder");
    expect(button.querySelector("svg")).not.toBeNull();
    button.click();
    expect(revealLocalFile).toHaveBeenCalledWith("/elsewhere/Plan.docx");
    expect(openLocalFile).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    local.view.requestUpdate();
    await local.view.updateComplete;
    expect(local.view.renderRoot.querySelectorAll(".file-reveal-button")).toHaveLength(1);

    const remote = await setup("docs/Plan.docx");
    expect(remote.view.renderRoot.querySelector(".file-reveal-button")).toBeNull();
  } finally {
    Reflect.deleteProperty(window, "piWebNative");
  }
  const outsideApp = await setup("docs/Plan.docx", "local");
  expect(outsideApp.view.renderRoot.querySelector(".file-reveal-button")).toBeNull();
});
