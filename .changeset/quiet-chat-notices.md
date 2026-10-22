---
"@jmfederico/pi-web": patch
---

Quiet extension notices in the Chat transcript. Text-only system notices, such as Disk low warnings, Atelier events and cache-miss notices, now render as one small muted line without a role label, and consecutive notices fold into one expandable "N notices" line showing the newest one. Expanding a notice or the fold shows its whole first line. Failures such as "Model response failed" or a failed Worker receipt stay fully visible, and special cards are unchanged. Assistant replies get a stronger role label and, in Grid tiles, a light background so they stand out from notices and tool steps.
