import type { FastifyReply } from "fastify";
import { workspaceCatalogHttpStatus } from "./workspaceCatalog.js";

/** A workspace the request may not use, with the status the route should answer. */
export class WorkspaceAccessError extends Error {
  override name = "WorkspaceAccessError";

  constructor(message: string, readonly statusCode: 403 | 404) {
    super(message);
  }
}

export function sendWorkspaceRequestError(
  reply: FastifyReply,
  error: unknown,
  fallbackStatus: number,
): FastifyReply {
  return reply.code(error instanceof WorkspaceAccessError ? error.statusCode : workspaceCatalogHttpStatus(error, fallbackStatus)).send({
    error: error instanceof Error ? error.message : String(error),
  });
}
