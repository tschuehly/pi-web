---
"@jmfederico/pi-web": patch
---

Reply to a selection in the Workbench Chat: select text inside one earlier message, with the mouse or the keyboard, and click Reply (or press Escape to dismiss) to stage it as a quote chip in the composer. Quotes from several messages can be staged and removed before sending; they are sent ahead of the reply as Markdown blockquotes anchored to their message (`> [msg <entry id>](#entry:<entry id>) excerpt`), and the quote's leading `msg` link scrolls to its source message when it is loaded.
