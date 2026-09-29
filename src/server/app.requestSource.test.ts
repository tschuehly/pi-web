import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import { requestSourceRejection } from "./requestSourceGuard.js";

registerAppTestHooks();

describe("request source guard", () => {
  it("rejects a foreign Host (DNS rebinding) and serves loopback hosts", async () => {
    const server = appTestContext.app;

    const foreign = await server.inject({ method: "GET", url: "/api/pi-web/health", headers: { host: "evil.example:8505" } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json<{ error: string }>().error).toContain("evil.example:8505");

    for (const host of ["localhost:8505", "127.0.0.1:8505", "[::1]:8505", "localhost"]) {
      const response = await server.inject({ method: "GET", url: "/api/pi-web/health", headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it("honours allowedHosts entries, subdomain entries, true, and the configured bind host", () => {
    const listed = { allowedHosts: ["pi.example.test", ".tailnet.test"] };
    expect(requestSourceRejection("pi.example.test:8504", undefined, listed)).toBeUndefined();
    expect(requestSourceRejection("mac.tailnet.test", undefined, listed)).toBeUndefined();
    expect(requestSourceRejection("tailnet.test", undefined, listed)).toBeUndefined();
    expect(requestSourceRejection("eviltailnet.test", undefined, listed)).toContain("rejected");
    expect(requestSourceRejection("evil.example", undefined, listed)).toContain("rejected");
    expect(requestSourceRejection("evil.example", undefined, { allowedHosts: true })).toBeUndefined();
    expect(requestSourceRejection("devbox.local:8504", undefined, { host: "devbox.local" })).toBeUndefined();
    expect(requestSourceRejection("evil.example/x", undefined, { allowedHosts: [] })).toContain("rejected");
    // A proxy that rewrites Host keeps working for Origins listed in allowedHosts.
    expect(requestSourceRejection("127.0.0.1:8504", "https://pi.example.test", listed)).toBeUndefined();
    // allowedHosts: true serves any Host but still refuses cross-site requests.
    expect(requestSourceRejection("127.0.0.1:8504", "https://evil.example", { allowedHosts: true })).toContain("cross-origin");
    expect(requestSourceRejection("127.0.0.1:8504", "null", {})).toContain("cross-origin");
  });

  it("rejects a cross-origin POST and accepts same-origin and Origin-less requests", async () => {
    const server = appTestContext.app;
    const request = (headers: Record<string, string>) => server.inject({ method: "POST", url: "/api/projects", headers: { host: "127.0.0.1:8505", ...headers }, payload: { path: "/definitely/missing/pi-web-project" } });

    const crossSite = await request({ origin: "https://evil.example" });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json<{ error: string }>().error).toContain("https://evil.example");
    expect((await request({ origin: "http://127.0.0.1:3000" })).statusCode).toBe(403);
    // Reaching the route (400 for the missing folder) proves the guard let them through.
    expect((await request({ origin: "http://127.0.0.1:8505" })).statusCode).toBe(400);
    expect((await request({})).statusCode).toBe(400);
  });

  it("rejects cross-origin and foreign-host WebSocket upgrades", async () => {
    const server = appTestContext.app;
    server.get("/api/test-socket", { websocket: true }, (socket) => { socket.close(); });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
    const { port } = address;
    const url = `ws://127.0.0.1:${String(port)}/api/test-socket`;

    await expect(upgradeStatus(url, { origin: "https://evil.example" })).resolves.toBe(403);
    await expect(upgradeStatus(url, { host: `evil.example:${String(port)}` })).resolves.toBe(403);
    await expect(upgradeStatus(url, { origin: `http://127.0.0.1:${String(port)}` })).resolves.toBe(101);
    await expect(upgradeStatus(url, {})).resolves.toBe(101);
  });
});

function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on("upgrade", (response) => { resolve(response.statusCode ?? 0); socket.terminate(); });
    socket.on("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); socket.terminate(); });
    socket.on("error", reject);
  });
}
