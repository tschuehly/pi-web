import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { AppState } from "../appState";

export class PanelCollapseController implements ReactiveController {
  navigationPanelCollapsed = false;
  workspacePanelCollapsed = false;

  hostConnected(): void {
    return;
  }

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  toggleNavigationPanel(): void {
    this.navigationPanelCollapsed = !this.navigationPanelCollapsed;
    this.host.requestUpdate();
  }

  toggleWorkspacePanel(): void {
    this.workspacePanelCollapsed = !this.workspacePanelCollapsed;
    this.host.requestUpdate();
  }

  expandNavigationPanel(): void {
    if (!this.navigationPanelCollapsed) return;
    this.navigationPanelCollapsed = false;
    this.host.requestUpdate();
  }

  expandWorkspacePanel(): void {
    if (!this.workspacePanelCollapsed) return;
    this.workspacePanelCollapsed = false;
    this.host.requestUpdate();
  }

  currentVisibility(): { navigation: { visible: boolean }; workspace: { visible: boolean } } {
    return {
      navigation: { visible: !this.navigationPanelCollapsed },
      workspace: { visible: !this.workspacePanelCollapsed },
    };
  }

  applyInitialVisibility(panels: { navigation?: { visible: boolean }; workspace?: { visible: boolean } } | undefined): void {
    const navigationPanelCollapsed = panels?.navigation === undefined ? this.navigationPanelCollapsed : !panels.navigation.visible;
    const workspacePanelCollapsed = panels?.workspace === undefined ? this.workspacePanelCollapsed : !panels.workspace.visible;
    if (navigationPanelCollapsed === this.navigationPanelCollapsed && workspacePanelCollapsed === this.workspacePanelCollapsed) return;
    this.navigationPanelCollapsed = navigationPanelCollapsed;
    this.workspacePanelCollapsed = workspacePanelCollapsed;
    this.host.requestUpdate();
  }

  shellClass(mainView: AppState["mainView"], primaryView = false): string {
    return [
      "shell",
      mainViewClass(mainView, primaryView),
      ...(this.navigationPanelCollapsed ? ["navigation-panel-collapsed"] : []),
      ...(this.workspacePanelCollapsed ? ["workspace-panel-collapsed"] : []),
    ].join(" ");
  }
}

export function mainViewClass(mainView: AppState["mainView"], primaryView = false): "navigation-view" | "chat-view" | "primary-view" | "workspace-view" {
  if (mainView === "navigation") return "navigation-view";
  if (mainView === "chat") return "chat-view";
  return primaryView ? "primary-view" : "workspace-view";
}
