---
"@jmfederico/pi-web": patch
---

`ask_user` questions now require a Markdown `detail` (up to 4000 characters) and the shared `context` loses its five-line cap, so a set explains itself and the agent's Chat message only says questions were posted. The panel strips the agent's own question numbering, renders each detail as Markdown, pre-fills an edited answer with the option's label and detail, and offers an optional Note for the whole set that reaches the agent with the answers.
