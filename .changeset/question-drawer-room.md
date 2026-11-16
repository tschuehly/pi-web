---
"@jmfederico/pi-web": patch
---

`ask_user` questions now require a Markdown `detail` (up to 4000 characters) and the shared `context` loses its five-line cap, so a set explains itself and the agent's Chat message only says questions were posted. The panel strips the agent's own question numbering, renders each detail as Markdown, lets the pencil on a hovered or focused option edit that option in place, pre-filled with its label and detail and sent as the Custom answer (Esc or Revert drops the edit), and offers an optional Note for the whole set that reaches the agent with the answers. Each question of a set can be sent on its own: its answer reaches the agent at once while the other questions stay open, and Send all sends the rest with the Note.
