---
"@jmfederico/pi-web": patch
---

Reply to a selection in the Workbench Chat: select text inside one earlier message, with the mouse or the keyboard, and click Reply (or press Escape to dismiss) to insert it at the composer's cursor as a Markdown blockquote anchored to its message (`> [msg <entry id>](#entry:<entry id>) excerpt`), with the cursor on a fresh line below it. Each quote shows collapsed to one line until clicked or until Enter is pressed beside it, then edits as ordinary text; several quotes can sit anywhere in the reply, are sent exactly as written, and survive a reload with the draft. The quote's leading `msg` link scrolls to its source message when it is loaded.
