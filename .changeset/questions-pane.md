---
"@jmfederico/pi-web": patch
---

Collect agent questions in a per-Chat Questions pane. `ask_user` now returns immediately instead of ending the run, requires a self-contained context, allows several open question sets per Chat, and lets the agent update or withdraw them. Each question has a short reference, open sets show when they were last updated and when they may be stale, ordinary chat messages no longer cancel them, and they are rebuilt from the transcript after a session-daemon restart. The Search files button moved from the Chat header into the Files pane toolbar; ⌘P still works.
