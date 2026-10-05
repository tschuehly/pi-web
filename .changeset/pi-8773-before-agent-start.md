---
"@jmfederico/pi-web": patch
---

Run extension `before_agent_start` hooks for agent runs started by custom messages with `triggerTurn`, by patching the bundled Pi SDK until upstream ships the fix (earendil-works/pi#8773).
