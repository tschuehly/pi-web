import { css, html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, type McpAuthServerOption, type SessionRef } from "../../api";
import { stylesheetIntegrationCapability } from "../../plugins/styles";
import { uiButtonStyles } from "../ui/controlStyles";
import { uiSettingsStyles } from "../ui/settingsStyles";
import "./SettingsPanelFrame";

export interface McpAuthContext {
  session: SessionRef;
  machineId: string;
}

export type McpAuthHandler = (mode: "login" | "logout", serverName: string, context: McpAuthContext) => void | Promise<void>;

@customElement("settings-mcp-panel")
export class SettingsMcpPanel extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  /** The parent supplies only a selected, nonarchived session on the settings machine. */
  @property({ attribute: false, hasChanged: (next: McpAuthContext | undefined, previous: McpAuthContext | undefined) =>
    next?.machineId !== previous?.machineId || next?.session.id !== previous?.session.id || next?.session.cwd !== previous?.session.cwd,
  }) context: McpAuthContext | undefined;
  @property() targetLabel = "this machine";
  @property({ attribute: false }) onMcpAuth?: McpAuthHandler;
  @state() private servers: McpAuthServerOption[] = [];
  @state() private loading = false;
  @state() private error = "";
  private generation = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) void this.reload();
  }

  override disconnectedCallback(): void {
    this.generation += 1;
    this.servers = [];
    this.error = "";
    this.loading = false;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("context")) void this.reload();
  }

  private isCurrent(generation: number, context: McpAuthContext): boolean {
    return this.isConnected && generation === this.generation
      && context.machineId === this.context?.machineId
      && context.session.id === this.context.session.id
      && context.session.cwd === this.context.session.cwd;
  }

  private async reload(): Promise<void> {
    const generation = ++this.generation;
    this.servers = [];
    this.error = "";
    this.loading = false;
    if (!this.isConnected || this.context === undefined) return;
    const context = { machineId: this.context.machineId, session: { ...this.context.session } };
    this.loading = true;
    try {
      const response = await api.mcpAuthServers(context.session, context.machineId);
      if (this.isCurrent(generation, context)) this.servers = response.servers;
    } catch (error) {
      if (this.isCurrent(generation, context)) this.error = `Could not load MCP servers: ${errorMessage(error)}`;
    } finally {
      if (this.isCurrent(generation, context)) this.loading = false;
    }
  }

  private async authenticate(mode: "login" | "logout", serverName: string, context: McpAuthContext): Promise<void> {
    const generation = this.generation;
    try {
      await this.onMcpAuth?.(mode, serverName, context);
    } catch (error) {
      if (this.isCurrent(generation, context)) this.error = `Could not open MCP authentication: ${errorMessage(error)}`;
    }
  }

  override render(): TemplateResult {
    const context = this.context === undefined ? undefined : {
      machineId: this.context.machineId, session: { ...this.context.session },
    };
    return html`
      <settings-panel-frame
        heading="MCP"
        .description=${"Manage authentication for enabled MCP servers that support OAuth in the selected session."}
        actionLabel="Refresh servers"
        .actionDisabled=${context === undefined || this.loading}
        .onAction=${() => this.reload()}
        .notices=${this.error === "" ? [] : [{ type: "error", content: this.error }]}
      >
        <section class="ui-settings-section">
          ${context === undefined ? html`
            <p role="status">Select a nonarchived session on ${this.targetLabel} to manage MCP authentication. Close settings to select a session, or use Configure machine to match the selected session’s machine.</p>
          ` : html`
            <div class="ui-settings-heading"><h3>Session context</h3></div>
            <div class="ui-settings-summary session-context" aria-label="MCP session context">
              <span><strong>Machine:</strong> ${this.targetLabel}</span>
              <span><strong>Session:</strong> ${context.session.id}</span>
              <span><strong>Workspace:</strong> ${context.session.cwd}</span>
            </div>
            <p>Logout removes local Pi credentials. It does not disable the server or revoke permission at the provider. Other sessions using those credentials are also affected.</p>
            ${this.loading ? html`<p role="status">Loading MCP servers…</p>` : this.error !== "" ? null : this.servers.length === 0 ? html`
              <p role="status">No enabled MCP servers with OAuth support are available in this session.</p>
            ` : html`
              <ul class="ui-settings-list server-list" aria-label="MCP servers">
                ${this.servers.map((server) => html`
                  <li class="ui-settings-row">
                    <div class="server-copy ui-settings-heading">
                      <h3>${server.name}</h3>
                      ${server.description === undefined ? null : html`<p class="server-description">${server.description}</p>`}
                    </div>
                    <div class="ui-settings-actions">
                      <button class="ui-button ui-button--action" aria-label=${`Login to ${server.name}`} ?disabled=${this.onMcpAuth === undefined} @click=${() => { void this.authenticate("login", server.name, context); }}>Login</button>
                      <button class="ui-button ui-button--action" aria-label=${`Logout from ${server.name}`} ?disabled=${this.onMcpAuth === undefined} @click=${() => { void this.authenticate("logout", server.name, context); }}>Logout</button>
                    </div>
                  </li>
                `)}
              </ul>
            `}
          `}
        </section>
      </settings-panel-frame>
    `;
  }

  static override styles = [uiButtonStyles, uiSettingsStyles, css`
    :host { display: block; }
    p { line-height: 1.45; }
    .ui-settings-section > p { margin: 0; }
    .session-context { overflow-wrap: anywhere; }
    .server-list { margin: 0; padding: 0; list-style: none; }
    .server-copy { flex: 1 1 240px; min-width: 0; }
    .server-description { white-space: pre-wrap; overflow-wrap: anywhere; }
  `];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-mcp-panel": SettingsMcpPanel;
  }
}
