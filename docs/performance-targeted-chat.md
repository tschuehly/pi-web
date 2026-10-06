# Opening a known Chat without waiting for its workspace catalog

A cold Chat URL, a project-less Chat URL, or a Workstream anchor names one Chat.
The Workbench used to list the Chat's whole workspace first and pick the row from that list.
It now asks for that one row, opens the Chat from it, and loads the full catalog in the background.
This document records the protocol, the call flow, and what the change does and does not claim.

## Protocol

`GET /sessions?cwd=<cwd>` is unchanged.
`GET /sessions?cwd=<cwd>&sessionId=<id>` is the targeted form:

- **Found:** `200` with exactly one `SessionInfo` row whose id is `<id>` and whose cwd is `<cwd>`.
  The row has the same shape and values as that session's row in the full listing.
  `archived`, `archivedAt`, and the archived `originalPath` all come from the current archive record.
- **Not found:** `404 {"error":"Session not found"}`.
  An empty `200` is never sent, so a current daemon's miss cannot be mistaken for an older daemon's reply.
- **Invalid id:** `400` if `sessionId` is empty, blank, longer than 512 characters, or repeated.
- **Older daemons** ignore `sessionId` and return the full catalog.
  The client still picks the row by id, so the archived flag is preserved.

The route already passes through the local session-daemon proxy and the remote-machine federation route unchanged, query string included.
No allowlist entry or transport change is needed.
A sessiond change only becomes active after a daemon restart.

## Server call flow

`sessionRoutes` → `SessionRouteService.list(cwd, { sessionId })` → `PiSessionService.listSession`:

1. In parallel, read `archiveStore.list()` and `gateway.list(cwd, { sessionId })`.
2. Re-filter the gateway result to an exact id and an equal cwd.
   Custom gateways that ignore the option stay correct, but they still scan the whole cwd.
3. **Archive first.** If an archive record has this exact id and cwd, project it with `clientSessionFromArchivedRecord`.
   This includes the legacy fallback to the persisted row.
   If the record cannot be projected, return nothing; it never becomes a writable row.
4. Otherwise, return the persisted row via `clientSessionFromListEntry`.
5. Otherwise, if this daemon already hosts an unpersisted Chat with this id and cwd, return its value-only projection.
   This is the same row `announceCreatedSession` builds, but nothing is published and runtime startup is not awaited.

This branch runs before any whole-cwd work, so the targeted lookup never runs unread, activity, or notification reconciliation.
The ordinary listing keeps that reconciliation, and the client still requests the ordinary listing in the background.

The lookup never calls `status`, `getOrOpen`, SDK `open`, runtime creation, or extension binding.
Opening an archived Chat for viewing still starts an SDK runtime through `messages`; this change only makes metadata discovery runtime-free.

### Native gateway

`gateway.list(cwd, { sessionId })`:

1. Locate the file with `resolveSessionFile`. This reads headers only, and filename candidates come first.
2. Reject a prefix resolution. A prefix never proves the exact id.
3. Summarize only that file with `SessionSummaryScanner.summarizeSessionFile`.
   This uses the same memo and the same 32-read scanner-wide bound as directory listings.
   It does not list the directory, prune its memo, or wait in the directory scan queue.
4. Check the summary's id and cwd again, because the path can be replaced between the header read and the summary read.

Freshness is the same as the full listing's.
The memo key is device, inode, and size.
Appends, renames, and cleared names change the size, and a replaced file changes the inode.
Detach invalidates the memo explicitly.
An unknown external rewrite that keeps both inode and size is the existing blind spot, shared with the full listing.

## Client call flow

`WorkbenchApp.knownSession` serves the complete Chat URL in `load`, the project-less URL in `openSessionAnywhere`, and the recorded Workstream anchor in `anchoredWorkstreamSession`:

1. Request `api.sessions(cwd, machineId, { sessionId })`.
2. If the reply is `404`, the Chat is unavailable. Never fall back to status.
3. Any other failure is reported as an error.
   For a Workstream anchor, it falls back to the existing locate path.
4. If the reply is `200`, pick the exact id.
   Only when an older daemon's full catalog lacks the row does the client use the old blank-Chat fallback, which rebuilds the row from `status`.
5. Select the row with the unchanged `SessionController.selectSession`, which honours `archived`.
   In parallel, `loadCatalogBehind` requests the full catalog.

The full catalog is applied only if the load sequence, machine, and workspace are still current.
Otherwise it is dropped.
When applied, the catalog keeps the opened and selected rows from in-memory state: their live title, a blank Chat the catalog cannot list yet, and the selection.
Drafts and selection are never touched.

Existing request reductions UI-001, UI-003, UI-006, UI-009, and WS-006 are unchanged.
The unanchored Workstream path still opens from `locate` and status without any listing.

## Request counts per cold known-Chat open

| Path | Before | After |
| --- | --- | --- |
| Complete Chat URL | 1 full catalog, which blocks selection | 1 targeted row, which blocks selection, then 1 full catalog in the background |
| Anchored Workstream Chat | 1 full catalog, which blocks selection | 1 targeted row, then 1 full catalog in the background |
| Native targeted lookup | n/a | header reads (filename candidates first) plus 1 file summary; no directory scan |

These are request and call counts, not timings.
No benchmark ran for this change.

## Benchmark guidance

A browser harness must hold back only the full catalog, `/sessions?cwd=…` without `sessionId`.
It must not delay the targeted request, and it must count full-catalog calls explicitly.
Otherwise, adding the query parameter changes the recorded route and could fake a pass on any assertion that the list was absent.
Compare the same isolated, copied workload before and after, including transcript and header milestones.
