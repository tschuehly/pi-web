import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";

/** Which Host names the web server answers, from the `host` and `allowedHosts` config. */
export interface RequestSourcePolicy {
  /** Same meaning as Vite's `server.allowedHosts`: `true` allows any host; a leading `.` also allows subdomains. */
  allowedHosts?: string[] | true;
  /** The configured bind host; like Vite, a named bind host is always allowed. */
  host?: string;
}

/**
 * Rejects requests another website can make from Thomas's browser: DNS rebinding
 * (a foreign Host name) and cross-site requests, including WebSocket upgrades,
 * which CORS does not protect. Requests without Origin (curl, server-side) pass.
 */
export function registerRequestSourceGuard(app: FastifyInstance, policy: RequestSourcePolicy = {}): void {
  app.addHook("onRequest", async (request, reply) => {
    const rejection = requestSourceRejection(request.headers.host, request.headers.origin, policy);
    if (rejection !== undefined) await reply.code(403).send({ error: rejection });
  });
}

export function requestSourceRejection(hostHeader: string | undefined, origin: string | undefined, policy: RequestSourcePolicy): string | undefined {
  // Browsers always send Host; a request without one cannot come from a rebinding page.
  const host = hostHeader === undefined ? undefined : parseHost(hostHeader);
  if (hostHeader !== undefined && (host === undefined || !isAllowedHostname(host.hostname, policy))) {
    return `PI WEB rejected a request for host "${hostHeader}". Add it to allowedHosts (PI_WEB_ALLOWED_HOSTS) to serve it.`;
  }
  if (origin === undefined) return undefined;
  const source = parseOrigin(origin);
  if (source === undefined) return `PI WEB rejected a cross-origin request from "${origin}".`;
  const sameOrigin = source.hostname === host?.hostname && source.port === host.port;
  if (sameOrigin || isListedHostname(source.hostname, policy)) return undefined;
  return `PI WEB rejected a cross-origin request from "${origin}".`;
}

function isAllowedHostname(hostname: string, policy: RequestSourcePolicy): boolean {
  if (policy.allowedHosts === true) return true;
  // IP literals cannot be DNS-rebinding names (Vite allows them too).
  if (isIP(stripBrackets(hostname)) !== 0) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (policy.host?.toLowerCase() === hostname) return true;
  return isListedHostname(hostname, policy);
}

/** Hosts listed in allowedHosts; an Origin from them is trusted even behind a Host-rewriting proxy. */
function isListedHostname(hostname: string, policy: RequestSourcePolicy): boolean {
  if (!Array.isArray(policy.allowedHosts)) return false;
  return policy.allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return allowed.startsWith(".") ? hostname === allowed.slice(1) || hostname.endsWith(allowed) : hostname === allowed;
  });
}

interface ParsedHost { hostname: string; port: string }

function parseHost(hostHeader: string): ParsedHost | undefined {
  try {
    const url = new URL(`http://${hostHeader}`);
    const bare = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
    return bare ? { hostname: url.hostname, port: url.port } : undefined;
  } catch {
    return undefined;
  }
}

function parseOrigin(origin: string): ParsedHost | undefined {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? { hostname: url.hostname, port: url.port } : undefined;
  } catch {
    return undefined;
  }
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
