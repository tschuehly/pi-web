---
"@jmfederico/pi-web": patch
---

Load Pi's built-in MCP, `codemode`, and `tool_search` extensions in PI WEB sessions, as the `pi` CLI does. Servers from `mcp.json` connect when a session starts, `/mcp` reports their status, and `-builtin:<name>` in the `extensions` setting disables a built-in.
