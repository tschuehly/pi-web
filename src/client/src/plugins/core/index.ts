import type { PiWebPlugin } from "../types";
import { createCoreActions } from "./actions";
import { createCoreWorkspacePanels } from "./panels";

export const corePlugin: PiWebPlugin = {
  apiVersion: 1,
  name: "PI WEB Core",
  activate: () => ({
    contributions: {
      actions: createCoreActions(),
      shellProfiles: [{
        id: "shell.default",
        title: "PI WEB",
        description: "The standard PI WEB conversation, navigation, and workspace-tool composition.",
        defaultPrimaryView: "conversation",
        navigationEntries: "all",
        surfaceContributions: "all",
        regions: {
          "context-bar": [],
          status: [],
          "surface-strip": [],
          "contextual-actions": [],
        },
        initialPanels: {
          navigation: { visible: true },
          workspace: { visible: true },
        },
      }],
      workspacePanels: createCoreWorkspacePanels(),
    },
  }),
};
