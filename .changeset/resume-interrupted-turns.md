---
"@jmfederico/pi-web": patch
---

Sessions that were mid-turn when the session daemon shut down now resume after it starts again. Shutdown records the busy sessions in `interrupted-turns.json` under the PI WEB data directory; the next startup consumes that record once and sends each session one system notice asking the agent to check what had finished and continue. Idle sessions are left alone, and a session that cannot be reopened is logged and skipped.
