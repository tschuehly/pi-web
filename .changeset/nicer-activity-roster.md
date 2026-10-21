---
"@jmfederico/pi-web": patch
---

The Activity roster shows each delegate on one line: a Lucide icon for its kind and state, its name, its own latest status report, how long ago it reported, and how long it has run. Failed and finished-to-collect delegates sort first and say so in words; a delegate silent for 10 minutes rises above the rest with a "may be stuck" marker. Model and effort move to the name's tooltip, the header counts only what is present ("1 failed · 2 running · 1 shell"), and a narrow Grid tile puts the report on a second line. Times need a Workbench build that publishes `startedAt`, `reportedAt` and `endedAt`; older builds simply show no times.
