---
"@jmfederico/pi-web": patch
---

Closing a Durable Chat's tab in the Workbench now also ends its host and background jobs, unless another open window still shows that Chat. When it still runs background bash jobs, Subagents or Workers, the Workbench first asks, naming them ("2 background bash jobs and 1 subagent are running; closing ends them."); Cancel keeps the tab. The check uses the Chat's current status from the server; when that status or the Chat's listing cannot be read, or the close cannot be saved, the tab stays and the host keeps running, so closing again retries. Legacy Chats only leave the window, as before.
