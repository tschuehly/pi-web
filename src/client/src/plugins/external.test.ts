import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExternalPlugins, resolvePluginModuleUrl } from "./external";

beforeEach(() => {
  vi.stubGlobal("document", { baseURI: "https://pi.example.test/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("external plugin manifests", () => {
  it("fetches the default manifest through the application base", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadExternalPlugins()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith("https://pi.example.test/pi-web-plugins/manifest.json", { cache: "no-store" });
  });

  it("loads manifest-relative modules from a nested deployment", async () => {
    const manifestUrl = "https://pi.example.test/test/ai/pi-web-plugins/manifest.json";
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      plugins: [{ id: "info", module: "./info/pi-web-plugin.js?v=1", machineSpecific: false }],
    }))));
    const moduleLoader = vi.fn(() => Promise.resolve({
      default: { apiVersion: 1, name: "Info", activate: () => ({ contributions: {} }) },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const registrations = await loadExternalPlugins(manifestUrl, { moduleLoader });

    expect(fetchMock).toHaveBeenCalledWith(manifestUrl, { cache: "no-store" });
    expect(moduleLoader).toHaveBeenCalledWith("https://pi.example.test/test/ai/pi-web-plugins/info/pi-web-plugin.js?v=1");
    expect(registrations).toMatchObject([{ id: "info", machineSpecific: false, plugin: { apiVersion: 1, name: "Info" } }]);
  });

  it("creates a browser-safe JSON client for declared plugin services", async () => {
    const manifestUrl = "https://pi.example.test/test/ai/pi-web-plugins/manifest.json";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        plugins: [{ id: "workstreams", module: "./workstreams/pi-web-plugin.js", service: "/api/pi-web-plugins/workstreams/service" }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ mode: "replay", events: [], nextSequence: 8 })));
    vi.stubGlobal("fetch", fetchMock);

    const registrations = await loadExternalPlugins(manifestUrl, {
      moduleLoader: () => Promise.resolve({ default: { apiVersion: 1, name: "Workstreams", activate: () => ({ contributions: {} }) } }),
    });
    const result = await registrations[0]?.service?.request("watch", { afterSequence: 8 });

    expect(result).toEqual({ mode: "replay", events: [], nextSequence: 8 });
    expect(fetchMock).toHaveBeenLastCalledWith("https://pi.example.test/api/pi-web-plugins/workstreams/service", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "watch", input: { afterSequence: 8 } }),
    });
  });

  it("treats root-style modules from existing manifests as application-root paths", () => {
    const rootManifestUrl = "https://pi.example.test/pi-web-plugins/manifest.json";
    const nestedManifestUrl = "https://pi.example.test/test/ai/pi-web-plugins/manifest.json";

    expect(resolvePluginModuleUrl("/pi-web-plugins/info/pi-web-plugin.js?v=1", rootManifestUrl, {
      viteBaseUrl: "/",
      documentBaseUrl: "https://pi.example.test/",
    })).toBe("https://pi.example.test/pi-web-plugins/info/pi-web-plugin.js?v=1");
    expect(resolvePluginModuleUrl("/pi-web-plugins/info/pi-web-plugin.js?v=1", nestedManifestUrl, {
      viteBaseUrl: "./",
      documentBaseUrl: "https://pi.example.test/test/ai/",
    })).toBe("https://pi.example.test/test/ai/pi-web-plugins/info/pi-web-plugin.js?v=1");
  });
});
