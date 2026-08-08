import { html, svg } from "lit";
import { CORE_CONVERSATION_VIEW_ID, SHELL_PROFILE_PANEL_BOUNDS, SHELL_REGION_LOCATIONS } from "../appShell/shellProfiles";
import type { NavigationEntryContribution, PiWebPluginRegistration, PluginAction, PluginRuntimeContext, PrimaryViewContext, PrimaryViewContribution, QualifiedContributionId, QualifiedNavigationEntryContribution, QualifiedPluginAction, QualifiedPrimaryViewContribution, QualifiedSessionStartGuardContribution, QualifiedShellContributionSelection, QualifiedShellProfileContribution, QualifiedShellRegionItem, QualifiedShellRegionItemContribution, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspaceLabelContribution, QualifiedWorkspacePanelContribution, SessionStartGuardContribution, ShellContributionSelection, ShellProfileCatalog, ShellProfileContribution, ShellProfilePanelState, ShellProfileProvenance, ShellRegionItemContribution, ShellRegionItemDescriptor, ShellRegionLocation, ThemeContribution, ThemePairContribution, WorkspaceLabelContext, WorkspaceLabelContribution, WorkspaceLabelItem, WorkspacePanelContext, WorkspacePanelContribution } from "./types";

const idPattern = /^[a-z][a-z0-9.-]*$/u;
const localIdPattern = /^[a-z][a-z0-9.-]*$/u;
const pluginRuntimeScopes = new WeakMap<PluginRuntimeContext, (pluginId: string) => PluginRuntimeContext>();
const workspacePanelScopes = new WeakMap<WorkspacePanelContext, (pluginId: string) => WorkspacePanelContext>();
const failedActionReason = "Unavailable because its plugin could not be evaluated.";

type RegisteredPluginAction = Omit<PluginAction, "id"> & {
  id: QualifiedContributionId;
  pluginId: string;
  localId: string;
  machineId?: string;
  sourcePluginId?: string;
};

export class PluginRegistry {
  private readonly actions: RegisteredPluginAction[] = [];
  private readonly navigationEntries: QualifiedNavigationEntryContribution[] = [];
  private readonly primaryViews: QualifiedPrimaryViewContribution[] = [];
  private readonly sessionStartGuards: QualifiedSessionStartGuardContribution[] = [];
  private readonly shellProfiles: QualifiedShellProfileContribution[] = [];
  private readonly shellProfileRegistrationErrors = new Map<QualifiedContributionId, string>();
  private readonly shellRegionItems: QualifiedShellRegionItemContribution[] = [];
  private readonly workspacePanels: QualifiedWorkspacePanelContribution[] = [];
  private readonly workspaceLabels: QualifiedWorkspaceLabelContribution[] = [];
  private readonly themes: QualifiedThemeContribution[] = [];
  private readonly themePairs: QualifiedThemePairContribution[] = [];
  private readonly pluginIds = new Set<string>();
  private readonly gatewayPluginIds = new Set<string>();
  private readonly gatewayMachineSpecificPluginIds = new Set<string>();
  private readonly remoteMachineSpecificPluginIds = new Map<string, Set<string>>();
  private readonly contributionIds = new Set<QualifiedContributionId>();

  register(registration: PiWebPluginRegistration): void {
    const { id, plugin } = registration;
    this.validatePluginId(id);
    const machineSpecific = this.parseMachineSpecific(id, registration.machineSpecific);
    if (this.pluginIds.has(id)) throw new Error(`Duplicate plugin id: ${id}`);
    if (this.isRemoteDuplicateHiddenByGateway(registration.sourcePluginId, registration.machineId, machineSpecific)) return;
    this.pluginIds.add(id);

    const apiVersion: unknown = plugin.apiVersion;
    if (apiVersion !== 1) throw new Error(`Unsupported plugin API version for ${id}: ${String(apiVersion)}`);
    const result = plugin.activate({ apiVersion: 1, pluginId: id, html, svg, ...(registration.service === undefined ? {} : { service: registration.service }) });
    const contributions = result.contributions;
    for (const action of contributions.actions ?? []) this.actions.push(this.qualifyAction(id, action, registration.machineId, registration.sourcePluginId));
    for (const view of contributions.primaryViews ?? []) this.primaryViews.push(this.qualifyPrimaryView(id, view, registration.machineId, registration.sourcePluginId));
    for (const entry of contributions.navigationEntries ?? []) this.navigationEntries.push(this.qualifyNavigationEntry(id, entry, registration.machineId, registration.sourcePluginId));
    for (const guard of contributions.sessionStartGuards ?? []) this.sessionStartGuards.push(this.qualifySessionStartGuard(id, guard, registration.machineId, registration.sourcePluginId));
    for (const item of contributions.shellRegionItems ?? []) this.shellRegionItems.push(this.qualifyShellRegionItem(id, item, registration.machineId, registration.sourcePluginId));
    for (const [index, profile] of (contributions.shellProfiles ?? []).entries()) this.registerShellProfile(id, plugin.name, profile, index, registration.machineId, registration.sourcePluginId);
    for (const panel of contributions.workspacePanels ?? []) this.workspacePanels.push(this.qualifyWorkspacePanel(id, panel, registration.machineId, registration.sourcePluginId));
    for (const contribution of contributions.workspaceLabels ?? []) this.workspaceLabels.push(this.qualifyWorkspaceLabelContribution(id, contribution, registration.machineId, registration.sourcePluginId));
    if (registration.machineId === undefined) {
      for (const theme of contributions.themes ?? []) this.themes.push(this.qualifyTheme(id, theme));
      for (const pair of contributions.themePairs ?? []) this.themePairs.push(this.qualifyThemePair(id, pair));
      this.gatewayPluginIds.add(id);
      if (machineSpecific) this.gatewayMachineSpecificPluginIds.add(id);
    } else if (registration.sourcePluginId !== undefined && machineSpecific) {
      addMappedSetValue(this.remoteMachineSpecificPluginIds, registration.sourcePluginId, registration.machineId);
    }
  }

  shouldLoadRemotePlugin(sourcePluginId: string, machineSpecific = false): boolean {
    return !this.gatewayPluginIds.has(sourcePluginId) || this.gatewayMachineSpecificPluginIds.has(sourcePluginId) || machineSpecific;
  }

  getActions(context: PluginRuntimeContext): QualifiedPluginAction[] {
    const selectedMachineId = runtimeContextMachineId(context);
    return this.actions.filter((action) => this.isContributionActive(action.pluginId, action.machineId, selectedMachineId, action.sourcePluginId)).map((action) => {
      const scopedContext = pluginRuntimeContextFor(context, action.pluginId);
      let enabled: boolean | undefined;
      let disabledReason: string | undefined;
      try {
        enabled = action.enabled?.(scopedContext);
      } catch (error) {
        warnContributionFailure("action enablement", action.id, error);
        enabled = false;
        disabledReason = failedActionReason;
      }
      if (enabled === false && disabledReason === undefined && action.disabledReason !== undefined) {
        try {
          disabledReason = action.disabledReason(scopedContext);
        } catch (error) {
          warnContributionFailure("action disabled reason", action.id, error);
          disabledReason = failedActionReason;
        }
      }
      const qualified: QualifiedPluginAction = {
        id: action.id,
        pluginId: action.pluginId,
        localId: action.localId,
        ...(action.machineId === undefined ? {} : { machineId: action.machineId }),
        title: action.title,
        run: () => action.run(scopedContext),
      };
      if (action.description !== undefined) qualified.description = action.description;
      if (action.shortcut !== undefined) qualified.shortcut = action.shortcut;
      if (action.group !== undefined) qualified.group = action.group;
      if (enabled !== undefined) qualified.enabled = enabled;
      if (disabledReason !== undefined && disabledReason !== "") qualified.disabledReason = disabledReason;
      return qualified;
    });
  }

  getNavigationEntries(context: PrimaryViewContext): QualifiedNavigationEntryContribution[] {
    const visibleViews = new Set(this.getPrimaryViews(context).map((view) => view.id));
    return this.navigationEntries
      .filter((entry) => visibleViews.has(entry.primaryView) && contributionVisible(entry, context))
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  getPrimaryViews(context: PrimaryViewContext): QualifiedPrimaryViewContribution[] {
    return this.primaryViews
      .filter((view) => contributionVisible(view, context))
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  getPrimaryView(id: QualifiedContributionId, context: PrimaryViewContext): QualifiedPrimaryViewContribution | undefined {
    return this.getPrimaryViews(context).find((view) => view.id === id);
  }

  getSessionStartDisabledReason(context: PrimaryViewContext): string | undefined {
    for (const guard of this.sessionStartGuards) {
      if (!this.isContributionActive(guard.pluginId, guard.machineId, context.machine.id, guard.sourcePluginId)) continue;
      try {
        const reason = guard.disabledReason(context);
        if (reason !== undefined && reason.trim() !== "") return reason;
      } catch (error) {
        warnContributionFailure("session start guard", guard.id, error);
      }
    }
    return undefined;
  }

  getShellProfileCatalog(context: PrimaryViewContext): ShellProfileCatalog {
    const profiles: QualifiedShellProfileContribution[] = [];
    const errors: Record<QualifiedContributionId, string> = Object.fromEntries(this.shellProfileRegistrationErrors);
    for (const profile of this.shellProfiles) {
      try {
        profiles.push(this.resolveShellProfile(profile.id, context));
      } catch (error) {
        errors[profile.id] = errorMessage(error);
      }
    }
    return { profiles, errors };
  }

  getRegisteredShellProfile(id: QualifiedContributionId): QualifiedShellProfileContribution | undefined {
    return this.shellProfiles.find((profile) => profile.id === id);
  }

  resolveShellProfile(id: QualifiedContributionId, context: PrimaryViewContext): QualifiedShellProfileContribution {
    const registrationError = this.shellProfileRegistrationErrors.get(id);
    if (registrationError !== undefined) throw new Error(registrationError);
    const profile = this.getRegisteredShellProfile(id);
    if (profile === undefined) throw new Error(`Shell profile ${id} is unavailable.`);
    if (!this.isContributionActive(profile.pluginId, profile.machineId, context.machine.id, profile.sourcePluginId)) {
      throw new Error(`Shell profile ${id} is unavailable for ${context.machine.name}.`);
    }
    this.validateShellProfileReferences(profile, context);
    return profile;
  }

  getShellNavigationEntries(profile: QualifiedShellProfileContribution, context: PrimaryViewContext): QualifiedNavigationEntryContribution[] {
    return selectQualifiedContributions(profile.navigationEntries, this.getNavigationEntries(context));
  }

  getShellWorkspacePanels(profile: QualifiedShellProfileContribution): QualifiedWorkspacePanelContribution[] {
    return selectQualifiedContributions(profile.surfaceContributions, this.getWorkspacePanels());
  }

  getShellRegionItems(profile: QualifiedShellProfileContribution, location: ShellRegionLocation, context: PrimaryViewContext): QualifiedShellRegionItem[] {
    const contributions = selectQualifiedContributions(
      profile.regions[location],
      this.shellRegionItems
        .filter((item) => item.location === location)
        .sort((left, right) => contributionOrder(left, right)),
    );
    return contributions.flatMap((contribution) => {
      try {
        if (!this.isContributionActive(contribution.pluginId, contribution.machineId, context.machine.id, contribution.sourcePluginId)) return [];
        if (contribution.visible?.(context) === false) return [];
        const descriptor = contribution.describe(context);
        validateShellRegionDescriptor(descriptor, contribution.id);
        const qualifiedItem: QualifiedShellRegionItem = { ...descriptor, id: contribution.id, pluginId: contribution.pluginId, localId: contribution.localId, location };
        return [qualifiedItem];
      } catch (error) {
        warnContributionFailure("shell region item", contribution.id, error);
        return [];
      }
    });
  }

  getWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    return [...this.workspacePanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  getThemes(): QualifiedThemeContribution[] {
    return [...this.themes].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getThemePairs(): QualifiedThemePairContribution[] {
    return [...this.themePairs].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getWorkspaceLabelItems(context: WorkspaceLabelContext): WorkspaceLabelItem[] {
    return [...this.workspaceLabels]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.id.localeCompare(right.id))
      .flatMap((contribution) => {
        try {
          if (contribution.visible?.(context) === false) return [];
          return contribution.items(context);
        } catch (error) {
          warnContributionFailure("workspace label", contribution.id, error);
          return [];
        }
      });
  }

  private validateShellProfileReferences(profile: QualifiedShellProfileContribution, context: PrimaryViewContext): void {
    if (profile.defaultPrimaryView !== CORE_CONVERSATION_VIEW_ID) {
      const view = this.primaryViews.find((candidate) => candidate.id === profile.defaultPrimaryView);
      if (view === undefined) throw new Error(`Shell profile ${profile.id} references missing primary view ${profile.defaultPrimaryView}.`);
      if (!strictContributionVisible(view, context)) throw new Error(`Shell profile ${profile.id} default primary view ${profile.defaultPrimaryView} is unavailable.`);
    }

    const navigationEntries = this.validateSelectedReferences(profile, "navigation entry", profile.navigationEntries, this.navigationEntries);
    if (profile.navigationEntries !== "all") {
      for (const entry of navigationEntries) {
        if (!strictContributionVisible(entry, context)) throw new Error(`Shell profile ${profile.id} navigation entry ${entry.id} is unavailable.`);
        if (!this.primaryViews.some((view) => view.id === entry.primaryView)) {
          throw new Error(`Shell profile ${profile.id} navigation entry ${entry.id} references missing primary view ${entry.primaryView}.`);
        }
      }
    }
    this.validateSelectedReferences(profile, "surface contribution", profile.surfaceContributions, this.workspacePanels);
    for (const location of SHELL_REGION_LOCATIONS) {
      const available = this.shellRegionItems.filter((item) => item.location === location);
      const selected = this.validateSelectedReferences(profile, `${location} item`, profile.regions[location], available);
      for (const contribution of selected) {
        if (!this.isContributionActive(contribution.pluginId, contribution.machineId, context.machine.id, contribution.sourcePluginId)) continue;
        if (strictContributionVisible(contribution, context)) validateShellRegionDescriptor(contribution.describe(context), contribution.id);
      }
    }
  }

  private validateSelectedReferences<T extends { id: QualifiedContributionId }>(profile: QualifiedShellProfileContribution, label: string, selection: QualifiedShellContributionSelection, available: readonly T[]): T[] {
    if (selection === "all") return [...available];
    const byId = new Map(available.map((contribution) => [contribution.id, contribution]));
    return selection.map((id) => {
      const contribution = byId.get(id);
      if (contribution === undefined) throw new Error(`Shell profile ${profile.id} references missing ${label} ${id}.`);
      return contribution;
    });
  }

  private registerShellProfile(pluginId: string, pluginName: string, profile: ShellProfileContribution, index: number, machineId: string | undefined, sourcePluginId: string | undefined): void {
    try {
      this.shellProfiles.push(this.qualifyShellProfile(pluginId, pluginName, profile, machineId, sourcePluginId));
    } catch (error) {
      const errorId: QualifiedContributionId = localIdPattern.test(profile.id) ? `${pluginId}:${profile.id}` : `${pluginId}:shell-profile.invalid-${String(index)}`;
      this.shellProfileRegistrationErrors.set(errorId, `Shell profile ${errorId} could not be registered: ${errorMessage(error)}`);
    }
  }

  private qualifyShellProfile(pluginId: string, pluginName: string, profile: ShellProfileContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedShellProfileContribution {
    const id = this.qualify(pluginId, profile.id);
    validateShellProfileMetadata(profile, id);
    const provenance: ShellProfileProvenance = {
      source: pluginId === "core" ? "built-in" : "plugin",
      pluginId,
      pluginName,
      ...(machineId === undefined ? {} : { machineId }),
    };
    return {
      ...profile,
      id,
      pluginId,
      localId: profile.id,
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
      defaultPrimaryView: this.qualifyShellReference(pluginId, profile.defaultPrimaryView),
      navigationEntries: this.qualifyShellSelection(pluginId, profile.navigationEntries),
      surfaceContributions: this.qualifyShellSelection(pluginId, profile.surfaceContributions),
      regions: {
        "context-bar": this.qualifyShellSelection(pluginId, profile.regions?.["context-bar"]),
        status: this.qualifyShellSelection(pluginId, profile.regions?.status),
        "surface-strip": this.qualifyShellSelection(pluginId, profile.regions?.["surface-strip"]),
        "contextual-actions": this.qualifyShellSelection(pluginId, profile.regions?.["contextual-actions"]),
      },
      provenance,
    };
  }

  private qualifyShellRegionItem(pluginId: string, contribution: ShellRegionItemContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedShellRegionItemContribution {
    if (!SHELL_REGION_LOCATIONS.includes(contribution.location)) throw new Error(`Invalid shell region location for ${pluginId}:${contribution.id}: ${contribution.location}`);
    return {
      ...contribution,
      id: this.qualify(pluginId, contribution.id),
      pluginId,
      localId: contribution.id,
      ...(machineId === undefined ? {} : { machineId }),
      ...(sourcePluginId === undefined ? {} : { sourcePluginId }),
    };
  }

  private qualifyShellSelection(pluginId: string, selection: ShellContributionSelection | undefined): QualifiedShellContributionSelection {
    if (selection === "all") return "all";
    return (selection ?? []).map((reference) => this.qualifyShellReference(pluginId, reference));
  }

  private qualifyShellReference(pluginId: string, reference: string): QualifiedContributionId {
    const separator = reference.indexOf(":");
    if (separator < 0) return this.qualifyReference(pluginId, reference);
    if (separator === 0 || separator === reference.length - 1 || reference.lastIndexOf(":") !== separator) throw new Error(`Invalid qualified contribution reference: ${reference}`);
    const referencedPluginId = reference.slice(0, separator);
    const localId = reference.slice(separator + 1);
    this.validatePluginId(referencedPluginId);
    this.validateLocalId(localId);
    return `${referencedPluginId}:${localId}`;
  }

  private qualifyAction(pluginId: string, action: PluginAction, machineId: string | undefined, sourcePluginId: string | undefined): RegisteredPluginAction {
    const id = this.qualify(pluginId, action.id);
    return { ...action, id, pluginId, localId: action.id, ...(machineId === undefined ? {} : { machineId }), ...(sourcePluginId === undefined ? {} : { sourcePluginId }) };
  }

  private qualifyPrimaryView(pluginId: string, view: PrimaryViewContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedPrimaryViewContribution {
    const id = this.qualify(pluginId, view.id);
    const visible = view.visible;
    return {
      ...view,
      id,
      pluginId,
      localId: view.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(context) ?? true),
    };
  }

  private qualifyNavigationEntry(pluginId: string, entry: NavigationEntryContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedNavigationEntryContribution {
    const id = this.qualify(pluginId, entry.id);
    const visible = entry.visible;
    const badge = entry.badge;
    return {
      ...entry,
      id,
      pluginId,
      localId: entry.id,
      primaryView: this.qualifyReference(pluginId, entry.primaryView),
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context) => this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId) && (visible?.(context) ?? true),
      ...(badge === undefined ? {} : { badge: (context: PrimaryViewContext) => {
        if (!this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)) return undefined;
        try {
          return badge(context);
        } catch (error) {
          warnContributionFailure("navigation badge", id, error);
          return undefined;
        }
      } }),
    };
  }

  private qualifySessionStartGuard(pluginId: string, guard: SessionStartGuardContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedSessionStartGuardContribution {
    return { ...guard, id: this.qualify(pluginId, guard.id), pluginId, localId: guard.id, ...(machineId === undefined ? {} : { machineId }), ...(sourcePluginId === undefined ? {} : { sourcePluginId }) };
  }

  private qualifyWorkspacePanel(pluginId: string, panel: WorkspacePanelContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedWorkspacePanelContribution {
    const id = this.qualify(pluginId, panel.id);
    const badge = panel.badge;
    const visible = panel.visible;
    return {
      ...panel,
      id,
      pluginId,
      localId: panel.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context: WorkspacePanelContext) => {
        if (!this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)) return false;
        try {
          return visible?.(workspacePanelContextFor(context, pluginId)) ?? true;
        } catch (error) {
          warnContributionFailure("workspace panel visibility", id, error);
          return false;
        }
      },
      ...(badge === undefined ? {} : { badge: (context: WorkspacePanelContext) => {
        if (!this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)) return undefined;
        try {
          return badge(workspacePanelContextFor(context, pluginId));
        } catch (error) {
          warnContributionFailure("workspace panel badge", id, error);
          return undefined;
        }
      } }),
      render: (context: WorkspacePanelContext) => panel.render(workspacePanelContextFor(context, pluginId)),
    };
  }

  private qualifyWorkspaceLabelContribution(pluginId: string, contribution: WorkspaceLabelContribution, machineId: string | undefined, sourcePluginId: string | undefined): QualifiedWorkspaceLabelContribution {
    const id = this.qualify(pluginId, contribution.id);
    const visible = contribution.visible;
    const items = contribution.items;
    return {
      ...contribution,
      id,
      pluginId,
      localId: contribution.id,
      ...(machineId === undefined ? {} : { machineId }),
      visible: (context) => {
        if (!this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)) return false;
        try {
          return visible?.(context) ?? true;
        } catch (error) {
          warnContributionFailure("workspace label visibility", id, error);
          return false;
        }
      },
      items: (context) => {
        if (!this.isContributionActive(pluginId, machineId, context.machine.id, sourcePluginId)) return [];
        try {
          return items(context).map((item) => item.type === "render" ? {
            ...item,
            render: () => {
              try {
                return item.render();
              } catch (error) {
                warnContributionFailure("workspace label render", id, error);
                return html``;
              }
            },
          } : item);
        } catch (error) {
          warnContributionFailure("workspace label items", id, error);
          return [];
        }
      },
    };
  }

  private qualifyTheme(pluginId: string, theme: ThemeContribution): QualifiedThemeContribution {
    const id = this.qualify(pluginId, theme.id);
    return { ...theme, id, pluginId, localId: theme.id };
  }

  private qualifyThemePair(pluginId: string, pair: ThemePairContribution): QualifiedThemePairContribution {
    const id = this.qualify(pluginId, pair.id);
    return {
      ...pair,
      id,
      pluginId,
      localId: pair.id,
      light: this.qualifyReference(pluginId, pair.light),
      dark: this.qualifyReference(pluginId, pair.dark),
    };
  }

  private qualify(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    const qualified: QualifiedContributionId = `${pluginId}:${localId}`;
    if (this.contributionIds.has(qualified)) throw new Error(`Duplicate contribution id: ${qualified}`);
    this.contributionIds.add(qualified);
    return qualified;
  }

  private qualifyReference(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    return `${pluginId}:${localId}`;
  }

  private isContributionActive(pluginId: string, machineId: string | undefined, selectedMachineId: string, sourcePluginId: string | undefined): boolean {
    if (machineId === undefined) return !this.isGatewayPluginHiddenForMachine(pluginId, selectedMachineId);
    return machineId === selectedMachineId && !this.isRemotePluginHiddenByGateway(sourcePluginId, machineId);
  }

  private isRemoteDuplicateHiddenByGateway(sourcePluginId: string | undefined, machineId: string | undefined, machineSpecific: boolean): boolean {
    return sourcePluginId !== undefined
      && machineId !== undefined
      && this.gatewayPluginIds.has(sourcePluginId)
      && !this.gatewayMachineSpecificPluginIds.has(sourcePluginId)
      && !machineSpecific;
  }

  private isRemotePluginHiddenByGateway(sourcePluginId: string | undefined, machineId: string): boolean {
    if (sourcePluginId === undefined) return false;
    if (this.gatewayMachineSpecificPluginIds.has(sourcePluginId)) return false;
    if (this.remoteMachineSpecificPluginIds.get(sourcePluginId)?.has(machineId) === true) return false;
    return this.gatewayPluginIds.has(sourcePluginId);
  }

  private isGatewayPluginHiddenForMachine(pluginId: string, machineId: string): boolean {
    return machineId !== "local" && (
      this.gatewayMachineSpecificPluginIds.has(pluginId)
      || this.remoteMachineSpecificPluginIds.get(pluginId)?.has(machineId) === true
    );
  }

  private validatePluginId(pluginId: string): void {
    if (!idPattern.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  }

  private validateLocalId(localId: string): void {
    if (!localIdPattern.test(localId)) throw new Error(`Invalid contribution id: ${localId}`);
  }

  private parseMachineSpecific(pluginId: string, value: unknown): boolean {
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw new Error(`Invalid plugin machineSpecific value for ${pluginId}: ${formatUnknownValue(value)}`);
    return value;
  }
}

function pluginRuntimeContextFor(context: PluginRuntimeContext, pluginId: string): PluginRuntimeContext {
  return pluginRuntimeScopes.get(context)?.(pluginId) ?? context;
}

function workspacePanelContextFor(context: WorkspacePanelContext, pluginId: string): WorkspacePanelContext {
  return workspacePanelScopes.get(context)?.(pluginId) ?? context;
}

export function installPluginRuntimeScope(context: PluginRuntimeContext, scope: (pluginId: string) => PluginRuntimeContext): PluginRuntimeContext {
  pluginRuntimeScopes.set(context, scope);
  return context;
}

export function installWorkspacePanelScope(context: WorkspacePanelContext, scope: (pluginId: string) => WorkspacePanelContext): WorkspacePanelContext {
  workspacePanelScopes.set(context, scope);
  return context;
}

function addMappedSetValue(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function runtimeContextMachineId(context: PluginRuntimeContext): string {
  return context.state.selectedMachine?.id ?? "local";
}

function warnContributionFailure(callback: string, id: string, error: unknown): void {
  console.warn(`Failed to evaluate ${callback} ${id}`, error);
}

function contributionVisible(contribution: { id: string; visible?: (context: PrimaryViewContext) => boolean }, context: PrimaryViewContext): boolean {
  try {
    return contribution.visible?.(context) !== false;
  } catch (error) {
    console.warn(`Failed to evaluate contribution visibility ${contribution.id}`, error);
    return false;
  }
}

function strictContributionVisible(contribution: { visible?: (context: PrimaryViewContext) => boolean }, context: PrimaryViewContext): boolean {
  return contribution.visible?.(context) !== false;
}

function selectQualifiedContributions<T extends { id: QualifiedContributionId }>(selection: QualifiedShellContributionSelection, available: readonly T[]): T[] {
  if (selection === "all") return [...available];
  const byId = new Map(available.map((contribution) => [contribution.id, contribution]));
  return selection.flatMap((id) => {
    const contribution = byId.get(id);
    return contribution === undefined ? [] : [contribution];
  });
}

function contributionOrder(left: { id: string; order?: number }, right: { id: string; order?: number }): number {
  return (left.order ?? 1000) - (right.order ?? 1000) || left.id.localeCompare(right.id);
}

function validateShellProfileMetadata(profile: ShellProfileContribution, id: QualifiedContributionId): void {
  validateBoundedLabel(profile.title, `Shell profile ${id} title`, 80);
  validateBoundedLabel(profile.description, `Shell profile ${id} description`, 240);
  if (profile.recommended !== undefined && typeof profile.recommended !== "boolean") throw new Error(`Shell profile ${id} recommended must be a boolean.`);
  if (profile.presentationProfile !== undefined) {
    validateBoundedLabel(profile.presentationProfile, `Shell profile ${id} presentation profile`, 80);
    if (!localIdPattern.test(profile.presentationProfile)) throw new Error(`Shell profile ${id} presentation profile id is invalid.`);
  }
  validateShellPanelState(profile.initialPanels?.navigation, "navigation", id);
  validateShellPanelState(profile.initialPanels?.workspace, "workspace", id);
}

function validateShellPanelState(state: ShellProfilePanelState | undefined, side: keyof typeof SHELL_PROFILE_PANEL_BOUNDS, profileId: QualifiedContributionId): void {
  if (state === undefined) return;
  if (typeof state.visible !== "boolean") throw new Error(`Shell profile ${profileId} ${side} panel visibility must be a boolean.`);
  if (state.size === undefined) return;
  const bounds = SHELL_PROFILE_PANEL_BOUNDS[side];
  if (!Number.isFinite(state.size) || state.size < bounds.min || state.size > bounds.max) {
    throw new Error(`Shell profile ${profileId} ${side} panel size must be between ${String(bounds.min)} and ${String(bounds.max)} pixels.`);
  }
}

function validateShellRegionDescriptor(descriptor: unknown, id: QualifiedContributionId): asserts descriptor is ShellRegionItemDescriptor {
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) throw new Error(`Shell region item ${id} did not return a descriptor.`);
  const type: unknown = Reflect.get(descriptor, "type");
  const label: unknown = Reflect.get(descriptor, "label");
  const title: unknown = Reflect.get(descriptor, "title");
  const tone: unknown = Reflect.get(descriptor, "tone");
  if (type !== "text" && type !== "action") throw new Error(`Shell region item ${id} returned an unsupported descriptor type.`);
  validateBoundedLabel(label, `Shell region item ${id} label`, 80);
  if (title !== undefined) validateBoundedLabel(title, `Shell region item ${id} title`, 240);
  if (tone !== undefined && tone !== "default" && tone !== "muted" && tone !== "accent" && tone !== "success" && tone !== "warning" && tone !== "danger") {
    throw new Error(`Shell region item ${id} returned an unsupported tone.`);
  }
  if (type === "text") {
    const value: unknown = Reflect.get(descriptor, "value");
    if (value !== undefined) validateBoundedLabel(value, `Shell region item ${id} value`, 240, true);
    return;
  }
  const invoke: unknown = Reflect.get(descriptor, "invoke");
  const badge: unknown = Reflect.get(descriptor, "badge");
  const active: unknown = Reflect.get(descriptor, "active");
  const disabled: unknown = Reflect.get(descriptor, "disabled");
  const disabledReason: unknown = Reflect.get(descriptor, "disabledReason");
  if (typeof invoke !== "function") throw new Error(`Shell region action ${id} must provide invoke().`);
  if (badge !== undefined && typeof badge !== "string" && typeof badge !== "number") throw new Error(`Shell region action ${id} badge must be text or a number.`);
  if (active !== undefined && typeof active !== "boolean") throw new Error(`Shell region action ${id} active state must be a boolean.`);
  if (disabled !== undefined && typeof disabled !== "boolean") throw new Error(`Shell region action ${id} disabled state must be a boolean.`);
  if (disabledReason !== undefined) validateBoundedLabel(disabledReason, `Shell region action ${id} disabled reason`, 240);
}

function validateBoundedLabel(value: unknown, label: string, maxLength: number, allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || value.length > maxLength) {
    throw new Error(`${label} must contain ${allowEmpty ? "at most" : "1 to"} ${String(maxLength)} characters.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
