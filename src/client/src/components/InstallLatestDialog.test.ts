// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { piWebApi } from "../api";
import { openInstallLatestDialog, type InstallLatestDialog } from "./InstallLatestDialog";
import type { InstallLatestPreview } from "../../../shared/installLatest";

const PREVIEW: InstallLatestPreview = {
  installed: { workbench: "1aa26dc8a2f9", piWeb: "6438f6977ca2" },
  latest: { workbench: "2bb37ed9b3fa", piWeb: "7549a7088db3" },
  merges: [{ repo: "pi-web", sha: "7549a7088db3", subject: "Install latest menu item" }],
  upToDate: false,
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function open(): Promise<InstallLatestDialog> {
  openInstallLatestDialog();
  const dialog = document.querySelector("install-latest-dialog");
  if (dialog === null) throw new Error("no dialog");
  await vi.waitFor(() => { expect(dialog.renderRoot.querySelector("[role=status]")).toBeNull(); });
  await dialog.updateComplete;
  return dialog;
}

const button = (dialog: InstallLatestDialog) => dialog.renderRoot.querySelector<HTMLButtonElement>(".install");

it("lists the merges and pairs, then installs exactly the installed and latest pairs it showed", async () => {
  vi.spyOn(piWebApi, "installLatestPreview").mockResolvedValue(PREVIEW);
  const install = vi.spyOn(piWebApi, "installLatest").mockResolvedValue({ status: "scheduled" });
  const dialog = await open();
  const text = dialog.renderRoot.textContent;
  expect(text).toContain("1aa26dc → 2bb37ed");
  expect(text).toContain("6438f69 → 7549a70");
  expect(dialog.renderRoot.querySelector(".merges")?.textContent).toContain("pi-web 7549a70 Install latest menu item");
  button(dialog)?.click();
  await vi.waitFor(() => { expect(dialog.renderRoot.textContent).toContain("Installing, PI WEB restarts in a few seconds."); });
  expect(install).toHaveBeenCalledWith(PREVIEW.installed, PREVIEW.latest, 1);
  expect(button(dialog)).toBeNull();
});

it("blocked preview shows the reason and disables Install", async () => {
  const reason = "refusing downgrade from the installed pair";
  vi.spyOn(piWebApi, "installLatestPreview").mockResolvedValue({ ...PREVIEW, blocked: reason });
  const install = vi.spyOn(piWebApi, "installLatest");
  const dialog = await open();
  expect(dialog.renderRoot.querySelector("[role=alert]")?.textContent).toBe(reason);
  expect(button(dialog)?.disabled).toBe(true);
  expect(dialog.renderRoot.querySelector(".recheck")).not.toBeNull();
  button(dialog)?.click();
  expect(install).not.toHaveBeenCalled();
});

it("up to date disables Install", async () => {
  vi.spyOn(piWebApi, "installLatestPreview").mockResolvedValue({ ...PREVIEW, latest: PREVIEW.installed, merges: [], upToDate: true });
  const dialog = await open();
  expect(button(dialog)?.disabled).toBe(true);
  expect(button(dialog)?.textContent).toBe("Up to date");
});

it("shows the script's refusal and Check again reloads the preview", async () => {
  const moved = "refusing: latest moved since you looked: now 3cc48fe0c4ab 7549a7088db3; review again";
  const newer = { ...PREVIEW, latest: { ...PREVIEW.latest, workbench: "3cc48fe0c4ab" } };
  const preview = vi.spyOn(piWebApi, "installLatestPreview").mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce(newer);
  const install = vi.spyOn(piWebApi, "installLatest").mockRejectedValueOnce(new Error(moved)).mockResolvedValue({ status: "scheduled" });
  const dialog = await open();
  button(dialog)?.click();
  await vi.waitFor(() => { expect(dialog.renderRoot.querySelector("[role=alert]")?.textContent).toBe(moved); });
  expect(button(dialog)?.disabled).toBe(false);
  dialog.renderRoot.querySelector<HTMLButtonElement>(".recheck")?.click();
  await vi.waitFor(() => { expect(dialog.renderRoot.textContent).toContain("1aa26dc → 3cc48fe"); });
  expect(preview).toHaveBeenCalledTimes(2);
  expect(dialog.renderRoot.querySelector("[role=alert]")).toBeNull();
  expect(dialog.renderRoot.querySelector(".recheck")).toBeNull();
  button(dialog)?.click();
  await vi.waitFor(() => { expect(install).toHaveBeenLastCalledWith(PREVIEW.installed, newer.latest, 1); });
});

it("shows a failed check and offers no install", async () => {
  vi.spyOn(piWebApi, "installLatestPreview").mockRejectedValue(new Error("git fetch failed"));
  const dialog = await open();
  expect(dialog.renderRoot.querySelector("[role=alert]")?.textContent).toBe("git fetch failed");
  expect(button(dialog)?.disabled).toBe(true);
});

it("nothing installed yet offers the first install of the latest pair", async () => {
  const none = { workbench: "none", piWeb: "none" };
  vi.spyOn(piWebApi, "installLatestPreview").mockResolvedValue({ ...PREVIEW, installed: none, merges: [] });
  const install = vi.spyOn(piWebApi, "installLatest").mockResolvedValue({ status: "scheduled" });
  const dialog = await open();
  expect(dialog.renderRoot.textContent).toContain("Nothing installed yet: Install sets up the latest pair 2bb37ed · 7549a70.");
  expect(dialog.renderRoot.querySelector(".warning")?.textContent).toContain("refuses if another install happened");
  expect(dialog.renderRoot.querySelector(".warning")?.textContent).toContain("A macOS confirmation appears on this Mac first");
  button(dialog)?.click();
  await vi.waitFor(() => { expect(install).toHaveBeenCalledWith(none, PREVIEW.latest, 0); });
});
