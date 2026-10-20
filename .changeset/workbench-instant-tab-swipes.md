---
"@jmfederico/pi-web": patch
---

Make two-finger tab swipes in the Workbench instant: the neighbour shows the moment a swipe goes a third of the way or flicks, without waiting for trackpad momentum, and one swipe moves exactly one tab. A gesture locks its axis like macOS, so scrolling a Chat up or down never slides it sideways, and a swipe towards no tab (past the first or last, or with a single tab) leaves the Chat still and the page in charge.
