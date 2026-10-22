---
"@jmfederico/pi-web": patch
---

Durable Chats gain Working Mode, `ask_user` questions and `request_attention` with the same chips, answers and notifications as other Chats, per-Chat model switching, AGENTS.md and skills loaded as Pi loads them, and a "Needs reconciliation" card to mark an interrupted tool call done, not done, or to retry. Sends and answers in a Durable Chat carry an operation ID, so a retried request is admitted once. Restart the session daemon to enable it.
