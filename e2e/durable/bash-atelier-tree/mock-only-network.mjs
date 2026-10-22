// Loaded by run.sh into every Node child, including legacy sessiond and the real Durable host.
// Fail closed on non-loopback TCP. Unix IPC sockets and local mock/Page endpoints remain available.
import { Socket } from "node:net";
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = values[0];
  const unix = (typeof options === "string" && !/^\d+$/.test(options)) || (options && typeof options === "object" && options.path);
  const host = options && typeof options === "object" ? options.host : typeof values[1] === "string" ? values[1] : undefined;
  if (!unix && host !== undefined && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error(`Fleet blocks non-fixture TCP destination: ${host}`);
  return connect.apply(this, args);
};
