---
"@jmfederico/pi-web": patch
---

Remove the unused workspace file-suggestion API (`GET /api/projects/:projectId/workspaces/:workspaceId/files`). Nothing in PI WEB calls it any more; file search uses the workspace `search` route.
