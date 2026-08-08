// @vitest-environment happy-dom

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_SHELL_PROFILE_ID, readStoredShellProfileId, writeStoredShellProfileId } from "../appShell/shellProfiles";
import { initialAppState, type AppState } from "../appState";
import { PluginRegistry } from "../plugins/registry";
import { PiWebApp } from "./PiWebApp";

const FIXTURE_PROFILE_ID = "fixture:shell.review";
const FIXTURE_VIEW_ID = "fixture:view.review";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("PiWebApp shell profiles", () => {
  it("restores a stored profile without clobbering the restored route or pushing history", () => {
    writeStoredShellProfileId(FIXTURE_PROFILE_ID);
    const app = createApp();
    registerFixtureProfile(app);
    const updateUrl = vi.fn();
    replaceMethod(app, "updateUrl", updateUrl);

    invoke(app, "restorePreferredShellProfile", false);

    expect(appState(app).mainView).toBe("chat");
    expect(privateValue(app, "activeShellProfileId")).toBe(FIXTURE_PROFILE_ID);
    expect(updateUrl).not.toHaveBeenCalled();
  });

  it("preserves the default PI WEB mobile navigation decoder", () => {
    const app = createApp();
    setPrivateValue(privateObject(app, "appShell"), "isMobileNavigationLayout", true);

    expect(invoke(app, "defaultRouteView")).toBe("navigation");
  });

  it("uses the profile default only when startup has no explicit view", () => {
    writeStoredShellProfileId(FIXTURE_PROFILE_ID);
    const app = createApp();
    registerFixtureProfile(app);
    const updateUrl = vi.fn();
    replaceMethod(app, "updateUrl", updateUrl);

    invoke(app, "restorePreferredShellProfile", true);

    expect(appState(app).mainView).toBe(FIXTURE_VIEW_ID);
    expect(updateUrl).not.toHaveBeenCalled();
  });

  it("keeps persisted intent through fallback and reapplies it after the plugin returns", () => {
    writeStoredShellProfileId(FIXTURE_PROFILE_ID);
    const app = createApp();

    invoke(app, "restorePreferredShellProfile", false);
    expect(privateValue(app, "activeShellProfileId")).toBe(CORE_SHELL_PROFILE_ID);
    expect(readStoredShellProfileId()).toBe(FIXTURE_PROFILE_ID);
    expect(String(privateValue(app, "shellProfileError"))).toContain("without forgetting your selection");

    registerFixtureProfile(app);
    setPrivateValue(app, "shellProfileRestoreReady", true);
    invoke(app, "reconcilePreferredShellProfile");
    expect(privateValue(app, "activeShellProfileId")).toBe(FIXTURE_PROFILE_ID);
    expect(appState(app).mainView).toBe("chat");
  });

  it("previews panel state and default view transactionally, then restores both on cancel", () => {
    const app = createApp();
    registerFixtureProfile(app);

    invoke(app, "previewShellProfile", FIXTURE_PROFILE_ID);
    expect(appState(app).mainView).toBe(FIXTURE_VIEW_ID);
    expect(panelVisibility(app)).toEqual({ navigation: { visible: false }, workspace: { visible: false } });
    expect(readStoredShellProfileId()).toBeUndefined();

    invoke(app, "cancelShellProfilePreview");
    expect(appState(app).mainView).toBe("chat");
    expect(panelVisibility(app)).toEqual({ navigation: { visible: true }, workspace: { visible: true } });
    expect(privateValue(app, "previewShellProfileId")).toBeUndefined();
  });

  it("keeps an open valid preview transactional across background reconciliation", () => {
    const app = createApp();
    registerFixtureProfile(app);
    invoke(app, "previewShellProfile", FIXTURE_PROFILE_ID);
    setPrivateValue(app, "shellProfileRestoreReady", true);

    invoke(app, "reconcilePreferredShellProfile");

    expect(privateValue(app, "previewShellProfileId")).toBe(FIXTURE_PROFILE_ID);
    expect(panelVisibility(app)).toEqual({ navigation: { visible: false }, workspace: { visible: false } });
    invoke(app, "cancelShellProfilePreview");
    expect(appState(app).mainView).toBe("chat");
    expect(panelVisibility(app)).toEqual({ navigation: { visible: true }, workspace: { visible: true } });
  });

  it("does not reapply initial panel state while reconciling an unchanged profile", () => {
    const app = createApp();
    registerFixtureProfile(app);
    invoke(app, "previewShellProfile", FIXTURE_PROFILE_ID);
    invoke(app, "applyShellProfilePreview");
    applyPanelVisibility(app, { navigation: { visible: true }, workspace: { visible: true } });
    setPrivateValue(app, "shellProfileRestoreReady", true);

    invoke(app, "reconcilePreferredShellProfile");

    expect(panelVisibility(app)).toEqual({ navigation: { visible: true }, workspace: { visible: true } });
  });

  it("quarantines a profile whose default view throws until an explicit retry", () => {
    const app = createApp();
    registerFixtureProfile(app);
    replaceMethod(app, "updateUrl", vi.fn());
    invoke(app, "previewShellProfile", FIXTURE_PROFILE_ID);
    invoke(app, "applyShellProfilePreview");

    invoke(app, "handleProfilePrimaryViewFailure", FIXTURE_VIEW_ID, new Error("render failed"));
    const failureNotice = privateValue(app, "shellProfileError");
    expect(privateValue(app, "activeShellProfileId")).toBe(CORE_SHELL_PROFILE_ID);
    expect(readStoredShellProfileId()).toBe(FIXTURE_PROFILE_ID);

    setPrivateValue(app, "shellProfileRestoreReady", true);
    invoke(app, "reconcilePreferredShellProfile");
    expect(privateValue(app, "activeShellProfileId")).toBe(CORE_SHELL_PROFILE_ID);
    expect(privateValue(app, "shellProfileError")).toBe(failureNotice);

    invoke(app, "previewShellProfile", FIXTURE_PROFILE_ID);
    expect(privateValue(app, "previewShellProfileId")).toBe(FIXTURE_PROFILE_ID);
  });

  it("persists only after explicit apply and resets through the protected core profile", () => {
    const app = createApp();
    registerFixtureProfile(app);

    invoke(app, "previewShellProfile", FIXTURE_PROFILE_ID);
    invoke(app, "applyShellProfilePreview");
    expect(readStoredShellProfileId()).toBe(FIXTURE_PROFILE_ID);

    invoke(app, "resetShellProfile");
    expect(privateValue(app, "activeShellProfileId")).toBe(CORE_SHELL_PROFILE_ID);
    expect(readStoredShellProfileId()).toBe(CORE_SHELL_PROFILE_ID);
    expect(appState(app).mainView).toBe("chat");
  });
});

function createApp(): PiWebApp {
  const app = new PiWebApp();
  setAppState(app, { ...initialAppState(), mainView: "chat" });
  return app;
}

function registerFixtureProfile(app: PiWebApp): void {
  registry(app).register({
    id: "fixture",
    plugin: {
      apiVersion: 1,
      name: "Fixture",
      activate: () => ({
        contributions: {
          primaryViews: [{ id: "view.review", title: "Review", render: () => html`<p>Review</p>` }],
          shellProfiles: [{
            id: "shell.review",
            title: "Review shell",
            description: "A generic fixture composition.",
            defaultPrimaryView: "view.review",
            initialPanels: {
              navigation: { visible: false, size: 320 },
              workspace: { visible: false, size: 480 },
            },
          }],
        },
      }),
    },
  });
}

function registry(app: PiWebApp): PluginRegistry {
  const value: unknown = privateValue(app, "plugins");
  if (!(value instanceof PluginRegistry)) throw new Error("Plugin registry unavailable");
  return value;
}

function panelVisibility(app: PiWebApp): unknown {
  const controller = panelController(app);
  const method: unknown = Reflect.get(controller, "currentVisibility");
  if (typeof method !== "function") throw new Error("Panel visibility unavailable");
  return Reflect.apply(method, controller, []);
}

function applyPanelVisibility(app: PiWebApp, panels: { navigation: { visible: boolean }; workspace: { visible: boolean } }): void {
  const controller = panelController(app);
  const method: unknown = Reflect.get(controller, "applyInitialVisibility");
  if (typeof method !== "function") throw new Error("Panel visibility mutation unavailable");
  Reflect.apply(method, controller, [panels]);
}

function panelController(app: PiWebApp): object {
  const controller: unknown = privateValue(app, "panelCollapse");
  if (typeof controller !== "object" || controller === null) throw new Error("Panel controller unavailable");
  return controller;
}

function appState(app: PiWebApp): AppState {
  const value: unknown = privateValue(app, "state");
  if (!isAppState(value)) throw new Error("App state unavailable");
  return value;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "sessions"));
}

function setAppState(app: PiWebApp, state: AppState): void {
  setPrivateValue(app, "state", state);
}

function invoke(app: PiWebApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = privateValue(app, name);
  if (typeof method !== "function") throw new Error(`PiWebApp.${name} unavailable`);
  return Reflect.apply(method, app, args);
}

function replaceMethod(app: PiWebApp, name: string, method: (...args: never[]) => unknown): void {
  setPrivateValue(app, name, method);
}

function privateValue(target: object, name: string): unknown {
  return Reflect.get(target, name);
}

function privateObject(target: object, name: string): object {
  const value: unknown = privateValue(target, name);
  if (typeof value !== "object" || value === null) throw new Error(`${name} unavailable`);
  return value;
}

function setPrivateValue(target: object, name: string, value: unknown): void {
  if (!Reflect.set(target, name, value)) throw new Error(`Could not set ${name}`);
}
