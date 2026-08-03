import type { TemplateResult } from "lit";
import type { AppAction } from "../actions";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeEntry, FileTreeResponse, GitDiffResponse, GitStatusResponse, Machine, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, Project, RunTerminalCommandInput, SessionInfo, TerminalCommandRun, TerminalCommandRunFilter, TerminalCommandRunHandle, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse, Workspace } from "../api";
import type { AppState } from "../appState";
import type { SettingsSection } from "../settingsRoute";
import type { LocalContributionId, PluginId, QualifiedContributionId } from "./ids";

export type { LocalContributionId, PluginId, QualifiedContributionId } from "./ids";
export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
export type SvgTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;

export interface PiWebPluginRegistration {
  id: PluginId;
  plugin: PiWebPlugin;
  service?: PluginService;
  machineId?: string;
  sourcePluginId?: PluginId;
  machineSpecific?: boolean;
}

export interface PiWebPlugin {
  apiVersion: 1;
  name: string;
  activate: (context: PluginActivationContext) => PluginActivationResult;
}

export interface PluginService {
  request(operation: string, input?: unknown): Promise<unknown>;
}

export interface PluginActivationContext {
  apiVersion: 1;
  pluginId: PluginId;
  html: HtmlTemplateTag;
  svg: SvgTemplateTag;
  service?: PluginService;
}

export interface PluginActivationResult {
  contributions: PluginContributions;
}

export interface PluginContributions {
  actions?: PluginAction[];
  navigationEntries?: NavigationEntryContribution[];
  primaryViews?: PrimaryViewContribution[];
  sessionStartGuards?: SessionStartGuardContribution[];
  workspacePanels?: WorkspacePanelContribution[];
  workspaceLabels?: WorkspaceLabelContribution[];
  themes?: ThemeContribution[];
  themePairs?: ThemePairContribution[];
}

export interface PluginMachine {
  id: string;
  name: string;
  kind: Machine["kind"];
}

export interface WorkspaceFiles {
  readFile(path: string): Promise<FileContentResponse>;
  listFiles(path: string): Promise<FileTreeResponse>;
  writeFile(path: string, content: string | Uint8Array, options?: WriteWorkspaceFileOptions): Promise<WriteWorkspaceFileResponse>;
  deleteFile(path: string): Promise<DeleteWorkspaceFileResponse>;
  moveFile(fromPath: string, toPath: string, options?: MoveWorkspaceFileOptions): Promise<MoveWorkspaceFileResponse>;
}

export interface WorkspaceHost {
  requestRender(): void;
}

export interface PluginSessionLocation {
  machineId: string;
  projectId?: string;
  workspaceId: string;
}

export interface PluginSessionHost {
  currentLocation(): PluginSessionLocation | undefined;
  start(options: { startupToken: string; initialPrompt: string }): Promise<{ id: string; location: PluginSessionLocation }>;
  open(location: { sessionId: string; machineId?: string; projectId?: string; workspaceId?: string }): Promise<void>;
  prompt(location: { sessionId: string; machineId?: string; projectId?: string; workspaceId?: string }, message: string): Promise<void>;
  findByStartupToken(startupToken: string, location?: Partial<PluginSessionLocation>): Promise<{ id: string; location: PluginSessionLocation } | undefined>;
}

export type PluginConnectionStatus = "connected" | "reconnecting";

export interface PrimaryViewContext {
  machine: PluginMachine;
  project?: Pick<Project, "id" | "name" | "path">;
  workspace?: Workspace;
  session?: Pick<SessionInfo, "id" | "archived">;
  connection: {
    status: PluginConnectionStatus;
    message?: string;
  };
  host: WorkspaceHost;
  sessions?: PluginSessionHost;
}

export interface SessionStartGuardContribution {
  id: LocalContributionId;
  disabledReason: (context: PrimaryViewContext) => string | undefined;
}

export interface QualifiedSessionStartGuardContribution extends SessionStartGuardContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
  sourcePluginId?: PluginId;
}

export type PrimaryViewIcon = TemplateResult;

export interface PrimaryViewContribution {
  id: LocalContributionId;
  title: string;
  ariaLabel?: string;
  order?: number;
  visible?: (context: PrimaryViewContext) => boolean;
  render: (context: PrimaryViewContext) => TemplateResult;
}

export interface QualifiedPrimaryViewContribution extends PrimaryViewContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
}

export interface NavigationEntryContribution {
  id: LocalContributionId;
  title: string;
  primaryView: LocalContributionId;
  icon?: PrimaryViewIcon;
  order?: number;
  visible?: (context: PrimaryViewContext) => boolean;
  badge?: (context: PrimaryViewContext) => string | number | TemplateResult | undefined;
}

export interface QualifiedNavigationEntryContribution extends Omit<NavigationEntryContribution, "primaryView"> {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
  primaryView: QualifiedContributionId;
}

export interface WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state: AppState;
  files: WorkspaceFiles;
  host: WorkspaceHost;
}

export type WorkspaceTerminalCommandInput = Omit<RunTerminalCommandInput, "workspace">;

export interface WorkspacePanelTerminal {
  open(options?: { terminalId?: string | undefined }): void;
  runCommand(input: WorkspaceTerminalCommandInput): Promise<TerminalCommandRunHandle>;
}

export interface PiWebUnstableRuntimeContext {
  terminalCommandRuns: TerminalCommandRunsInternalRuntime;
  openSettings?: (section?: SettingsSection) => void;
}

export interface TerminalCommandRunsInternalRuntime {
  runCommand(input: RunTerminalCommandInput): Promise<TerminalCommandRunHandle>;
  listCommandRuns(filter?: TerminalCommandRunFilter): Promise<TerminalCommandRun[]>;
  getCommandRun(runId: string): Promise<TerminalCommandRun | undefined>;
  open(options?: { terminalId?: string | undefined }): void;
}

export interface PluginPromptEditor {
  insertText(text: string): void;
  getText(): string;
  getSelection(): { start: number; end: number; text: string } | null;
}

export interface PluginRuntimeContext {
  state: AppState;
  prompt: PluginPromptEditor;
  piWebUnstable?: PiWebUnstableRuntimeContext;
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  addMachine: () => void | Promise<void>;
  refreshSelectedMachine: () => void | Promise<void>;
  removeSelectedMachine: () => void | Promise<void>;
  openSelectedMachine: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  openThemePicker: () => void;
  openModelPicker: () => void | Promise<void>;
  openThinkingLevelPicker: () => void | Promise<void>;
  selectMainView: (view: AppState["mainView"]) => void;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  openTerminal: (options?: { terminalId?: string | undefined }) => void;
  refreshFiles: () => void | Promise<void>;
  refreshGit: () => void | Promise<void>;
  refreshAppData: () => void | Promise<void>;
  checkForPiWebUpdates?: () => void | Promise<void>;
  reloadPage: () => void;
  deleteWorkspace: (workspace?: Workspace) => void | Promise<void>;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  reloadSession: () => void | Promise<void>;
  deleteCachedNewSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}

export interface PluginAction {
  id: LocalContributionId;
  title: string;
  description?: string;
  shortcut?: string;
  group?: string;
  enabled?: (context: PluginRuntimeContext) => boolean;
  /** Explain why a disabled action is visible but unavailable. */
  disabledReason?: (context: PluginRuntimeContext) => string | undefined;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
}

export interface QualifiedPluginAction extends AppAction {
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
}

export interface WorkspacePanelContext extends WorkspaceContext {
  prompt: PluginPromptEditor;
  terminal: WorkspacePanelTerminal;
  /**
   * @deprecated Runtime-only compatibility alias for pre-v2 plugins. Use `terminal.open()` instead.
   * This is intentionally not part of the public `@jmfederico/pi-web/plugin-api` declarations.
   */
  openTerminal?: (options?: { terminalId?: string | undefined }) => void;
  piWebUnstable?: Pick<PiWebUnstableRuntimeContext, "terminalCommandRuns">;
  fileTree: FileTreeEntry[];
  expandedDirs: Record<string, FileTreeEntry[]>;
  selectedFilePath: string | undefined;
  selectedFileContent: FileContentResponse | undefined;
  fileTreeStale: boolean;
  gitStatus: GitStatusResponse | undefined;
  selectedDiffPath: string | undefined;
  selectedDiff: GitDiffResponse | undefined;
  selectedStagedDiff: GitDiffResponse | undefined;
  gitStale: boolean;
  activeTerminalCount: number;
  selectedTerminalId: string | undefined;
  terminalAutoStart: boolean;
  workspaceUploadDefaultFolder: string;
  onRefreshFiles: () => void;
  onExpandDir: (path: string) => void;
  onSelectFile: (path: string) => void | Promise<void>;
  onStartWorkspaceUpload: (files: readonly File[], options: { destinationFolder: string; createDirs?: boolean; overwrite?: boolean; selectUploadedFile?: boolean }) => { batchId: string; done: Promise<void> } | undefined;
  onCancelWorkspaceUpload: (batchId: string) => void;
  onClearWorkspaceUpload: (batchId: string) => void;
  onRefreshGit: () => void;
  onSelectDiff: (path: string) => void;
  onSelectTerminal: (terminalId: string | undefined, options?: { replace?: boolean | undefined }) => void;
}

export type WorkspacePanelIcon = TemplateResult;

export interface WorkspacePanelContribution {
  id: LocalContributionId;
  title: string;
  icon?: WorkspacePanelIcon;
  order?: number;
  visible?: (context: WorkspacePanelContext) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

export interface QualifiedWorkspacePanelContribution extends WorkspacePanelContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
}

export interface WorkspaceLabelContext extends WorkspaceContext {
  machine: PluginMachine;
  workspace: Workspace;
  state: AppState;
  files: WorkspaceFiles;
  host: WorkspaceHost;
}

export type WorkspaceLabelItem = WorkspaceLabelTextItem | WorkspaceLabelLinkItem | WorkspaceLabelRenderItem;

export interface WorkspaceLabelTextItem {
  type: "text";
  text: string;
  title?: string;
}

export interface WorkspaceLabelLinkItem {
  type: "link";
  text: string;
  href: string;
  title?: string;
  target?: "_blank" | "_self";
}

export interface WorkspaceLabelRenderItem {
  type: "render";
  render: () => TemplateResult;
}

export interface WorkspaceLabelContribution {
  id: LocalContributionId;
  order?: number;
  visible?: (context: WorkspaceLabelContext) => boolean;
  items: (context: WorkspaceLabelContext) => WorkspaceLabelItem[];
}

export type ThemeColorScheme = "dark" | "light";

export type ThemeToken =
  | "--pi-bg"
  | "--pi-surface"
  | "--pi-surface-hover"
  | "--pi-terminal-bg"
  | "--pi-terminal-text"
  | "--pi-border"
  | "--pi-border-muted"
  | "--pi-text"
  | "--pi-text-secondary"
  | "--pi-text-bright"
  | "--pi-muted"
  | "--pi-dim"
  | "--pi-accent"
  | "--pi-accent-border"
  | "--pi-selection-bg"
  | "--pi-success"
  | "--pi-success-border"
  | "--pi-success-bg"
  | "--pi-success-surface"
  | "--pi-success-ring"
  | "--pi-warning"
  | "--pi-warning-border"
  | "--pi-warning-surface"
  | "--pi-danger"
  | "--pi-purple"
  | "--pi-purple-border"
  | "--pi-purple-surface"
  | "--pi-overlay"
  | "--pi-shadow-soft"
  | "--pi-shadow"
  | "--pi-shadow-strong"
  | "--pi-bg-overlay-soft"
  | "--pi-bg-overlay"
  | "--pi-success-bg-overlay"
  | "--pi-terminal-selection";

export type ThemeTokens = Record<ThemeToken, string>;

export interface ThemeContribution {
  id: LocalContributionId;
  name: string;
  description?: string;
  order?: number;
  colorScheme: ThemeColorScheme;
  tokens: ThemeTokens;
}

export interface ThemePairContribution {
  id: LocalContributionId;
  name: string;
  description?: string;
  order?: number;
  light: LocalContributionId;
  dark: LocalContributionId;
}

export interface QualifiedThemeContribution extends ThemeContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
}

export interface QualifiedThemePairContribution extends Omit<ThemePairContribution, "id" | "light" | "dark"> {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  light: QualifiedContributionId;
  dark: QualifiedContributionId;
}

export interface QualifiedWorkspaceLabelContribution extends WorkspaceLabelContribution {
  id: QualifiedContributionId;
  pluginId: PluginId;
  localId: LocalContributionId;
  machineId?: string;
}
