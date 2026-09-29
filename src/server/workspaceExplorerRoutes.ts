import type { FastifyInstance } from "fastify";
import type { WriteWorkspaceFileOptions } from "../shared/apiTypes.js";
import type { PiWebConfigService } from "./configRoutes.js";
import type { ProjectService } from "./projects/projectService.js";
import { deleteWorkspaceFile, moveWorkspaceFile, readWorkspaceFile, writeWorkspaceFile, WorkspaceFileConflictError, WorkspaceFileOutcomeUnknownError } from "./workspaces/fileContentService.js";
import { isAbsoluteishFileSuggestionQuery, listFileSuggestions, listPathSuggestions } from "./workspaces/fileSuggestions.js";
import { listWorkspaceTree, searchWorkspaceFiles } from "./workspaces/fileTreeService.js";
import { isAbsoluteishPath } from "./workspaces/pathAccessPolicy.js";
import { readWorkspaceFilePreview } from "./workspaces/filePreviewService.js";
import { workspaceFilePreviewResponsePolicy } from "./workspaces/filePreviewResponsePolicy.js";
import { applyWorkspaceFilePreviewErrorResponsePolicy } from "./workspaces/filePreviewResponseHeaders.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import { pathAccessForWorkspaceContext } from "./workspaces/effectivePathAccess.js";
import type { WorkspaceCatalog } from "./workspaces/workspaceCatalog.js";
import { sendWorkspaceRequestError } from "./workspaces/workspaceRouteErrors.js";

export interface WorkspaceExplorerRouteOptions {
  config?: Pick<PiWebConfigService, "read">;
}

export function registerWorkspaceExplorerRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceCatalog, prefix = "/api", options: WorkspaceExplorerRouteOptions = {}): void {
  registerWorkspaceFileContentParsers(app);
  // File routes also serve ad-hoc folder workspaces (folder:<absolute directory>).
  const resolveContext = (params: { projectId: string; workspaceId: string }) =>
    resolveWorkspaceContext(projects, workspaces, params.projectId, params.workspaceId, true);

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { q?: string; cursor?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/search`, async (request, reply) => {
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", onClose);
    try {
      const context = await resolveContext(request.params);
      return await searchWorkspaceFiles(context.root, request.query.q ?? "", request.query.cursor ?? "", controller.signal);
    } catch (error) {
      return await sendWorkspaceRequestError(reply, error, 400);
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/tree`, async (request, reply) => {
    try {
      const context = await resolveContext(request.params);
      const pathAccess = isAbsoluteishPath(request.query.path ?? "") ? await pathAccessForWorkspaceContext(context, options.config) : undefined;
      return await listWorkspaceTree(context.root, request.query.path, pathAccess);
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveContext(request.params);
      const pathAccess = isAbsoluteishPath(request.query.path ?? "") ? await pathAccessForWorkspaceContext(context, options.config) : undefined;
      return await readWorkspaceFile(context.root, request.query.path, pathAccess);
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });

  app.put<{ Params: { projectId: string; workspaceId: string }; Body: Buffer; Querystring: { path?: string; createDirs?: string; overwrite?: string; expectedVersion?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveContext(request.params);
      const writeOptions: WriteWorkspaceFileOptions = {
        createDirs: request.query.createDirs !== "false",
        ...(request.query.overwrite !== undefined ? { overwrite: request.query.overwrite !== "false" } : {}),
        ...(request.query.expectedVersion !== undefined ? { expectedVersion: request.query.expectedVersion } : {}),
      };
      return await writeWorkspaceFile(context.root, request.query.path, request.body, writeOptions);
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, error instanceof WorkspaceFileOutcomeUnknownError ? 500 : error instanceof WorkspaceFileConflictError ? 409 : 400);
    }
  });

  app.delete<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveContext(request.params);
      return await deleteWorkspaceFile(context.root, request.query.path);
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });

  app.post<{ Params: { projectId: string; workspaceId: string }; Querystring: { fromPath?: string; toPath?: string; createDirs?: string; overwrite?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/move`, async (request, reply) => {
    try {
      const context = await resolveContext(request.params);
      return await moveWorkspaceFile(context.root, request.query.fromPath, request.query.toPath, {
        createDirs: request.query.createDirs !== "false",
        overwrite: request.query.overwrite === "true",
      });
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string; download?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/preview`, async (request, reply) => {
    try {
      const context = await resolveContext(request.params);
      const download = request.query.download === "1" || request.query.download === "true";
      const pathAccess = isAbsoluteishPath(request.query.path ?? "") ? await pathAccessForWorkspaceContext(context, options.config) : undefined;
      const preview = await readWorkspaceFilePreview(context.root, request.query.path, pathAccess, { download });
      const policy = workspaceFilePreviewResponsePolicy(preview.path, { download });
      return await reply
        .header("Content-Type", policy.contentType)
        .header("Cache-Control", "private, max-age=3600")
        .header("Content-Length", String(preview.size))
        .header("Content-Disposition", policy.contentDisposition)
        .header("Content-Security-Policy", policy.contentSecurityPolicy)
        .header("Last-Modified", new Date(preview.modifiedAt).toUTCString())
        .header("X-Content-Type-Options", policy.contentTypeOptions)
        .send(preview.body);
    } catch (error) {
      applyWorkspaceFilePreviewErrorResponsePolicy(reply);
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { q?: string; kind?: "tracked" | "untracked" | "other"; mode?: "file" | "path"; scope?: "tracked" | "all" } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/files`, async (request, reply) => {
    try {
      const context = await resolveContext(request.params);
      const query = request.query.q ?? "";
      const pathAccess = isAbsoluteishFileSuggestionQuery(query) ? await pathAccessForWorkspaceContext(context, options.config) : undefined;
      if (request.query.mode === "path") return await listPathSuggestions(context.root, query, pathAccess);
      return await listFileSuggestions(context.root, query, { kind: request.query.kind, scope: request.query.scope, pathAccess });
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });
}

function registerWorkspaceFileContentParsers(app: FastifyInstance): void {
  // Fastify's default parser only handles JSON; workspace file writes need to
  // accept text and arbitrary binary payloads. This route module is registered
  // for both local aliases, so parser registration must tolerate repeats.
  try { app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => { done(null, Buffer.from(body)); }); } catch { /* already registered */ }
  try { app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); }); } catch { /* already registered */ }
  try { app.addContentTypeParser(/^([a-z]+\/[a-z0-9.+-]+)$/u, { parseAs: "buffer" }, (_request, body, done) => { done(null, body); }); } catch { /* already registered */ }
}
