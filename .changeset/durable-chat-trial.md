---
"@jmfederico/pi-web": patch
---

Add an opt-in Durable Chat runtime for trials. A session daemon started with `PI_WEB_DURABLE_HOST` offers New Durable Chat beside New Chat; that Chat runs on its own Durable host with read, write, edit and bash, streaming, queued follow-ups, Stop and reload. Legacy Chats stay the default and are unchanged. Restart the session daemon to enable it.
