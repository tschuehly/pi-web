---
"@jmfederico/pi-web": patch
---

Durable Chats can go back in their history: `/tree` and the message actions (Go back, Revert to here, Edit & resend) continue from an earlier entry and keep every later branch, also after a restart. Navigation waits until the Chat is idle and its questions and Working Mode follow the selected branch. Branch summaries and forking into a new Chat stay hidden in Durable Chats. Revert and Edit & resend are now hidden in Durable Chats whose host does not support history navigation. Restart the session daemon to enable it.
