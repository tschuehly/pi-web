/** AC-P017 AC-P018 AC-P021 AC-P052 AC-P059 AC-P060: owner deferrals, not passing acceptance evidence. */
import { test } from "@playwright/test";
for (const [id, description] of [
  ["AC-P017", "enabled-model catalog / scope"],
  ["AC-P018", "cycle model"],
  ["AC-P021", "session defaults"],
  ["AC-P052", "untraced /session stats command"],
  ["AC-P059", "MCP status and auth"],
  ["AC-P060", "MCP tools"],
]) test.skip(`${id} skipped: deferred — ${description}`, () => {});
