---
"@jmfederico/pi-web": patch
---

Closing a Durable Chat's tab in the Workbench now also ends its host and background jobs, unless another browser window still shows that Chat. The server makes the final call once the closing tab has stopped watching: it refuses while any browser still watches the Chat, and while work runs it first asks, naming it ("2 background bash jobs and 1 subagent are running; closing ends them."). The Workbench asks the same before the tab goes; Cancel keeps the tab. Work started after that check is asked about again, and Cancel then leaves the Chat running. When the Chat's listing or status cannot be read within 5 seconds, or the close cannot be saved, the tab stays and the host keeps running, so closing again retries. Legacy Chats only leave the window, as before.

A Durable Chat's host idle for 2 hours with no browser watching now also closes when it serves Atelier Pages; the Pages end with it, and reopening the Chat serves them again.
