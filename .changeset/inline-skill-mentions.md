---
"@jmfederico/pi-web": patch
---

Load skills mentioned anywhere in a prompt: a known `/skill:name` after the start of a message now expands into the skill's instructions in place, instead of reaching the model as plain text. Mentions inside code spans or fences and unknown skill names stay literal.
