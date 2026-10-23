import "./mock-only-network.mjs";
import assert from "node:assert/strict";
import { createServer, Socket } from "node:net";
assert.throws(() => new Socket().connect({ host: "203.0.113.1", port: 443 }), /Fleet blocks/);
assert.throws(() => new Socket().connect(443, "api.anthropic.com"), /Fleet blocks/);
const server = createServer((socket) => socket.end());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  await new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.once("error", reject);
    socket.once("close", resolve);
    socket.connect(server.address().port, "127.0.0.1");
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
