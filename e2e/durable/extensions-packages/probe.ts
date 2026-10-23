// Copied into the fixture's bound package, never installed in the owner's profile.
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function probe(pi: ExtensionAPI) {
  pi.registerCommand("fleet-status", {
    description: "Fixture extension status publication",
    handler: async (args, ctx) => { ctx.ui.setStatus("fleet-probe", args === "clear" ? undefined : args); },
  });
  pi.on("resources_discover", () => ({ skillPaths: [join(dirname(process.env["PI_CODING_AGENT_DIR"]!), "contributed-skill")] }));
}
