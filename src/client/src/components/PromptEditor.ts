import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown, deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER, type FileSuggestion, type PromptAttachment, type SessionModel, type SessionStatus, type SlashCommand } from "../api";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { capturePromptAttachments, effectivePromptAttachmentDelivery, isInlinePromptAttachment, promptAttachmentsCanUseInlineDelivery, READ_FAILURE_MESSAGE } from "../promptAttachmentCapture";
import { isSupportedImageMimeType } from "../../../shared/promptAttachments";
import { inputModeForDraft, inputModesEqual, type InputMode } from "../inputModes";
import { machineSessionKey } from "../machineKeys";
import { WORKING_MODE_STATUS_KEY } from "../extensionStatusSnapshots";
import { detectPromptCompletionTrigger, fileCompletionInsertText, modelCompletionChoices, type PromptCompletionTrigger } from "../promptCompletions";
import { promptArgumentHintExtension, setPromptArgumentHint } from "../promptArgumentHint";
import { clearDraft, loadDraft, saveDraft } from "../promptDraftStorage";
import { clearStagedAttachments, emptyStagedAttachmentDraft, loadStagedAttachmentDraft, resolveStagedAttachmentKey, saveStagedAttachments, type PendingAttachment } from "../promptAttachmentStaging";
import { loadAttachmentDelivery, saveAttachmentDelivery } from "../attachmentPreferences";
import { createMobilePromptEnterMedia, promptStreamingBehaviorForEnter, shouldUsePromptEnterShiftShortcut } from "../promptEnterBehavior";
import { composerKeyboardSubmissionEnabled, composerSendShortcut, matchesComposerSend } from "../composerShortcuts";
import type { ShortcutPreferenceConfig } from "../keyboardShortcuts";
import { promptEditorStyles, type CompletionItem } from "./shared";
import { renderAttachIcon, renderSendIcon, renderQueueIcon, renderSteerIcon, renderStopIcon, renderThinkingGauge } from "./promptEditorIcons";
import "./WorkingModeControls";
import { thinkingGauge, thinkingLevelLabel } from "../../../shared/thinkingLevels";
import { formatCost, formatTokenCount } from "../utils/format";
import "./AutocompleteMenu";

@customElement("prompt-editor")
export class PromptEditor extends LitElement {
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) shortcuts: ShortcutPreferenceConfig = {};
  @property() sessionId?: string;
  @property() cwd?: string;
  @property() machineId = "local";
  @property() projectId?: string;
  @property() workspaceId?: string;
  /**
   * Workspace-effective folder for the "save to folder" attachment delivery.
   * Shown in the delivery label and sent explicitly with the save request, so
   * the save destination is always the folder the label advertised.
   */
  @property() attachmentsFolder = DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER;
  @property({ type: Boolean }) canSteer = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Boolean }) canStop = false;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Boolean, reflect: true, attribute: "show-usage" }) showUsage = false;
  @property({ type: Number }) warningCount = 0;
  @property({ type: Boolean }) sending = false;
  @property({ attribute: false }) onSend?: (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery, folder?: string) => unknown;
  @property({ attribute: false }) onStop?: () => void;
  @property({ attribute: false }) onSelectModel?: () => void;
  @property({ attribute: false }) onSelectThinking?: () => void;
  @property({ attribute: false }) onRunCommand?: (command: string) => void | Promise<void>;
  @property({ attribute: false }) availableThinkingLevels: readonly string[] = [];
  @query(".markdown-editor") private editorHost?: HTMLDivElement;
  @query(".attachment-input") private attachmentInput?: HTMLInputElement;
  // `draft` is the live document text but is intentionally NOT reactive: it
  // changes on every keystroke and the visible text is owned by CodeMirror, not
  // by Lit's render. Re-rendering the surrounding template on each keystroke is
  // wasted work and, on iOS, can interrupt an in-progress touch gesture (the
  // long-press edit/paste callout). Only `currentInputMode` (shell vs. normal)
  // is reactive, since that is the only draft-derived value the template shows.
  private draft = "";
  @state() private currentInputMode: InputMode = { kind: "normal" };
  @state() private completions: CompletionItem[] = [];
  @state() private selectedIndex = 0;
  @state() private attachments: readonly PendingAttachment[] = [];
  @state() private attachmentDelivery: PromptAttachmentDelivery = loadAttachmentDelivery();
  @state() private attachmentError: string | undefined = undefined;
  private attachmentSeq = 0;
  private nextImageReference = 1;
  private pendingImageReferences: readonly string[] = [];
  private draftGeneration = 0;
  private knownCommandNames = new Set<string>();
  private commandCatalogRequest: Promise<SlashCommand[]> | undefined;
  private requestVersion = 0;
  private completionResultVersion = 0;
  private completionResultTrigger: string | undefined;
  private editor: EditorView | undefined;
  private readonly editableCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();
  private readonly mobilePromptEnterMedia = createMobilePromptEnterMedia();
  private explicitShiftKeyActive = false;

  protected override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("sessionId") && !changed.has("machineId")) return;
    const previousSessionId = changed.has("sessionId") ? changed.get("sessionId") : this.sessionId;
    const previousMachineId = changed.has("machineId") ? changed.get("machineId") : this.machineId;
    const previousKey = draftStorageKey(previousMachineId, previousSessionId);
    if (previousKey !== undefined) {
      saveDraft(previousKey, this.draft);
      saveStagedAttachments(previousKey, this.stagedAttachmentDraft());
    }
    const currentKey = draftStorageKey(this.machineId, this.sessionId);
    const staged = currentKey !== undefined ? loadStagedAttachmentDraft(currentKey) : emptyStagedAttachmentDraft();
    this.attachments = staged.attachments;
    this.nextImageReference = staged.nextImageReference;
    this.pendingImageReferences = staged.pendingImageReferences;
    this.draftGeneration = staged.generation;
    this.draft = sanitizeDraftImageReferences(currentKey !== undefined ? loadDraft(currentKey) : "", this.attachments, this.pendingImageReferences);
    if (currentKey !== undefined) saveDraft(currentKey, this.draft);
    this.attachmentError = undefined;
    this.knownCommandNames.clear();
    this.commandCatalogRequest = undefined;
    this.requestVersion += 1;
    this.currentInputMode = inputModeForDraft(this.draft);
    this.completions = [];
    this.selectedIndex = 0;
  }

  protected override shouldUpdate(changed: PropertyValues<this>): boolean {
    // Status updates churn once per token during streaming and hand us a fresh
    // object reference each time. When nothing else changed, only re-render if a
    // status field the template actually displays differs, so streaming does not
    // disturb the editor DOM (and any in-progress touch gesture survives).
    if (changed.has("status") && changed.size === 1) {
      return !sessionStatusRenderEqual(changed.get("status"), this.status, this.showUsage);
    }
    return true;
  }

  override firstUpdated(): void {
    this.createEditor();
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("disabled")) this.updateEditorDisabledState();
    if (changed.has("sessionId") || changed.has("machineId")) this.syncEditorDoc();
  }

  override disconnectedCallback(): void {
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const shellInputMode = this.currentInputMode.kind === "shell" ? this.currentInputMode : undefined;
    const shellMode = shellInputMode !== undefined;
    const steersInput = this.canSteer && !this.isCompacting;
    const queuesInput = this.canSteer || this.isCompacting;
    const busy = this.disabled || this.sending;
    return html`
      <footer class=${shellMode ? "shell-mode" : ""} @paste=${(event: ClipboardEvent) => { void this.handlePaste(event); }} @dragover=${(event: DragEvent) => { this.handleDragOver(event); }} @drop=${(event: DragEvent) => { void this.handleDrop(event); }}>
        <div class="editor-wrap">
          <div class=${`markdown-editor${this.disabled ? " markdown-editor-disabled" : ""}`} aria-label="Message pi" aria-disabled=${this.disabled ? "true" : "false"}></div>
          <input class="attachment-input" type="file" multiple hidden @change=${(event: Event) => { void this.handleFileInput(event); }} />
          <button class="editor-attach icon-button" ?disabled=${busy} title="Attach files" aria-label="Attach files" @click=${() => { this.attachmentInput?.click(); }}>${renderAttachIcon()}</button>
          ${shellMode ? html`<div class="mode-hint">Shell command${shellInputMode.excludeFromContext ? " · excluded from context" : ""}</div>` : null}
          ${this.isCompacting && !shellMode ? html`<div class="mode-hint">Compacting history · message will be queued</div>` : null}
          ${this.renderAttachments()}
          <autocomplete-menu .items=${this.currentCompletions()} .selectedIndex=${this.selectedIndex} .onPick=${(item: CompletionItem) => { this.pick(item); }}></autocomplete-menu>
        </div>
        <div class="actions">
          ${this.renderCompactStatus()}
          ${this.showUsage ? this.renderUsage() : null}
          <working-mode-controls compact .status=${this.status} .onRunCommand=${this.onRunCommand}></working-mode-controls>
          <div class="composer-actions">
            <button class="icon-button send-button" ?disabled=${busy} title=${steersInput ? "Steer at the next available boundary" : queuesInput ? "Queue until the current activity finishes" : "Send message"} aria-label=${steersInput ? "Steer current response" : queuesInput ? "Queue message" : "Send message"} @click=${() => { void this.send(steersInput ? "steer" : "followUp"); }}>${steersInput ? renderSteerIcon() : queuesInput ? renderQueueIcon() : renderSendIcon()}</button>
            ${steersInput ? html`<button class="icon-button queue-button" ?disabled=${busy} title="Queue until the current response finishes" aria-label="Queue follow-up" @click=${() => { void this.send("followUp"); }}>${renderQueueIcon()}</button>` : null}
            <button class="icon-button stop-button" ?disabled=${this.disabled || !this.canStop} title=${this.canStop ? "Stop current work" : "Nothing running"} aria-label="Stop current work" @click=${() => this.onStop?.()}>${renderStopIcon()}</button>
          </div>
        </div>
      </footer>
    `;
  }

  focusInput() {
    this.editor?.focus();
  }

  prependText(text: string): void {
    this.replaceText(this.draft === "" ? text : `${text}\n\n${this.draft}`);
  }

  replaceText(text: string): void {
    this.draft = text;
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) saveDraft(key, text);

    const editor = this.editor;
    if (editor !== undefined) {
      const current = editor.state.doc.toString();
      editor.dispatch({
        ...(current === text ? {} : { changes: { from: 0, to: current.length, insert: text } }),
        selection: EditorSelection.cursor(text.length),
      });
    }

    // Invalidate completion requests started for either the previous document or
    // the replacement dispatch, then return the editor to a clean completion state.
    this.requestVersion += 1;
    this.currentInputMode = inputModeForDraft(text);
    this.completions = [];
    this.selectedIndex = 0;
  }

  /** Get the underlying CM6 EditorView, or undefined if not yet mounted. */
  get view(): EditorView | undefined {
    return this.editor;
  }

  private renderCompactStatus() {
    const status = this.status;
    if (status === undefined) return null;
    const model = status.model?.id ?? "no model";
    const provider = status.model?.provider !== undefined && status.model.provider !== "" ? `${status.model.provider}/` : "";
    return html`
      <div class="compact-status" aria-label="Session status">
        <button class="select-model" title="Select model" @click=${() => this.onSelectModel?.()}>${provider}${model}</button>
        <button class="select-thinking icon-button" title=${`Thinking level: ${thinkingLevelLabel(status.thinkingLevel)}`} aria-label=${`Thinking level: ${thinkingLevelLabel(status.thinkingLevel)}`} @click=${() => this.onSelectThinking?.()}>${renderThinkingGauge(thinkingGauge(status.thinkingLevel, this.availableThinkingLevels))}</button>
      </div>
    `;
  }

  private renderUsage() {
    const status = this.status;
    if (status === undefined) return null;
    const context = status.contextUsage;
    const exactContextPercent = context?.percent === null || context?.percent === undefined ? undefined : String(context.percent);
    const visibleContextPercent = context?.percent?.toFixed(1);
    const contextText = context === undefined
      ? "Context unknown"
      : visibleContextPercent === undefined
        ? context.tokens === null ? `Context window ${formatTokenCount(context.contextWindow)}` : `Context ${formatTokenCount(context.tokens)}/${formatTokenCount(context.contextWindow)}`
        : `Context ${visibleContextPercent}%`;
    const contextLabel = context === undefined
      ? "Context usage unavailable"
      : context.tokens === null
        ? `Context used tokens unavailable; window: ${String(context.contextWindow)} tokens`
        : `Context: ${String(context.tokens)} of ${String(context.contextWindow)} tokens used${exactContextPercent === undefined ? "" : ` (${exactContextPercent}%)`}`;
    const metric = (name: string, visible: string, exact: string) => html`<li data-usage=${name} title=${exact}><span aria-hidden="true">${visible}</span><span class="visually-hidden">${exact}</span></li>`;
    return html`
      <ul class="usage" aria-label="Session usage">
        ${metric("input", `Input ${formatTokenCount(status.tokens.input)}`, `Input tokens: ${String(status.tokens.input)}`)}
        ${metric("output", `Output ${formatTokenCount(status.tokens.output)}`, `Output tokens: ${String(status.tokens.output)}`)}
        ${metric("context", contextText, contextLabel)}
        ${metric("cost", `Cost ${formatCost(status.cost)}`, `Session cost: $${String(status.cost)}`)}
        ${this.warningCount > 0 ? metric("warnings", `Warnings ${String(this.warningCount)}`, `Session warnings: ${String(this.warningCount)}`) : null}
        ${status.pendingMessageCount > 0 ? metric("queued", `Queued ${String(status.pendingMessageCount)}`, `Queued messages: ${String(status.pendingMessageCount)}`) : null}
      </ul>
    `;
  }

  private renderAttachments() {
    if (this.attachments.length === 0 && this.attachmentError === undefined) return null;
    const canUseInlineDelivery = promptAttachmentsCanUseInlineDelivery(this.attachments);
    const delivery = this.effectiveAttachmentDelivery();
    return html`
      <div class="attachments" aria-label="Pending attachments">
        ${this.attachments.map((attachment) => html`
          <div class=${`attachment-chip ${isInlinePromptAttachment(attachment) ? "attachment-chip-image" : "attachment-chip-file"}`} title=${attachment.kind === "image" ? `${attachment.reference} ${attachment.name}` : attachment.name}>
            ${this.renderAttachmentPreview(attachment)}
            <button type="button" class="attachment-remove" title=${attachment.kind === "image" ? `Remove ${attachment.reference} image` : "Remove attachment"} aria-label=${attachment.kind === "image" ? `Remove ${attachment.reference} image ${attachment.name}` : `Remove ${attachment.name}`} @click=${() => { this.removeAttachment(attachment.id); }}>×</button>
          </div>
        `)}
        ${this.attachments.length > 0 ? html`
          <label class="attachment-delivery" title=${canUseInlineDelivery ? "How attachments are delivered to the agent" : "General files are saved and mentioned from the workspace"}>
            <select .value=${delivery} @change=${(event: Event) => { this.changeDelivery(event); }}>
              <option value="inline" ?disabled=${!canUseInlineDelivery}>Attach to message${canUseInlineDelivery ? "" : " (images only)"}</option>
              <option value="folder">${attachmentFolderDeliveryLabel(this.attachmentsFolder)}</option>
            </select>
          </label>
        ` : null}
        ${this.attachmentError !== undefined ? html`<div class="attachment-error">${this.attachmentError}</div>` : null}
      </div>
    `;
  }

  private renderAttachmentPreview(attachment: PendingAttachment) {
    if (attachment.kind === "image" && isInlinePromptAttachment(attachment)) {
      return html`<img src=${`data:${attachment.mimeType};base64,${attachment.data}`} alt=${`${attachment.reference} image ${attachment.name}`} /><span class="attachment-image-reference">${attachment.reference}</span>`;
    }
    return html`
      <div class="attachment-file-preview" aria-hidden="true">${fileExtensionLabel(attachment.name)}</div>
      <span class="attachment-file-name">${attachment.name}</span>
    `;
  }

  private changeDelivery(event: Event) {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const requested = event.target.value === "folder" ? "folder" : "inline";
    if (requested === "inline" && !promptAttachmentsCanUseInlineDelivery(this.attachments)) {
      event.target.value = "folder";
      return;
    }
    this.attachmentDelivery = requested;
    saveAttachmentDelivery(this.attachmentDelivery);
  }

  private removeAttachment(id: string) {
    const removed = this.attachments.find((attachment) => attachment.id === id);
    this.attachments = this.attachments.filter((attachment) => attachment.id !== id);
    if (removed?.kind === "image") this.removeImageReferenceTokens(removed.reference);
    this.saveCurrentStaging();
  }

  private async handlePaste(event: ClipboardEvent) {
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    await this.addAttachmentFiles(files, this.editor?.state.selection.main.head ?? this.draft.length);
  }

  private handleDragOver(event: DragEvent) {
    if (event.dataTransfer === null) return;
    if (dataTransferHasFiles(event.dataTransfer)) event.preventDefault();
  }

  private async handleDrop(event: DragEvent) {
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    const position = this.editor?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? this.editor?.state.selection.main.head ?? this.draft.length;
    await this.addAttachmentFiles(files, position);
  }

  private async handleFileInput(event: Event) {
    if (!(event.target instanceof HTMLInputElement) || event.target.files === null) return;
    const files = Array.from(event.target.files);
    event.target.value = "";
    await this.addAttachmentFiles(files, this.editor?.state.selection.main.head ?? this.draft.length);
  }

  private async addAttachmentFiles(files: File[], position: number) {
    if (this.pendingImageReferences.length === 0) this.attachmentError = undefined;
    const sourceKey = draftStorageKey(this.machineId, this.sessionId);
    const generation = this.draftGeneration;
    const draftAtInvocation = this.draft;
    const reserved = files.map((file) => ({
      file,
      id: `attachment-${String(++this.attachmentSeq)}`,
      ...(isSupportedImageFile(file) ? { reference: `[PIC_${String(this.nextImageReference++)}]` } : {}),
    }));
    const references = reserved.flatMap((entry) => entry.reference === undefined ? [] : [entry.reference]);
    this.pendingImageReferences = [...this.pendingImageReferences, ...references];
    this.saveCurrentStaging();
    const capturedPromise = Promise.all(reserved.map(async (entry) => ({ entry, result: await capturePromptAttachments([entry.file], readFileAsBase64) })));
    // Known leading commands/templates/skills must stay byte-compatible for Pi
    // expansion. Unknown slash-leading prose (for example /Users/...) still gets
    // a visible token; all images retain their internal reference and preview.
    const commandCandidate = leadingSlashCommandName(draftAtInvocation) !== undefined;
    const suppressTokens = commandCandidate && await this.isLeadingCommandDraft(draftAtInvocation);
    if (generation !== this.draftGeneration) { await capturedPromise; return; }
    const insertionPosition = position === draftAtInvocation.length ? this.draft.length : position;
    if (references.length > 0 && !suppressTokens) this.insertImageReferenceTokens(references, insertionPosition);

    const captured = await capturedPromise;
    const additions: PendingAttachment[] = [];
    let failed = false;
    for (const { entry, result } of captured) {
      const attachment = result.attachments[0];
      if (attachment === undefined) {
        failed = true;
        continue;
      }
      if (attachment.kind === "image" && entry.reference !== undefined) additions.push({ ...attachment, id: entry.id, reference: entry.reference });
      else if (attachment.kind === "file") additions.push({ ...attachment, id: entry.id });
    }
    const failedReferences = reserved.flatMap((entry) => additions.some((attachment) => attachment.id === entry.id) || entry.reference === undefined ? [] : [entry.reference]);
    const targetKey = sourceKey === undefined ? undefined : resolveStagedAttachmentKey(sourceKey);
    if (targetKey !== undefined && targetKey !== draftStorageKey(this.machineId, this.sessionId)) {
      const staged = loadStagedAttachmentDraft(targetKey);
      if (staged.generation !== generation) return;
      const attachments = [...staged.attachments, ...additions].sort((a, b) => attachmentIdSequence(a.id) - attachmentIdSequence(b.id));
      const pendingImageReferences = staged.pendingImageReferences.filter((reference) => !references.includes(reference));
      saveStagedAttachments(targetKey, { ...staged, attachments, pendingImageReferences });
      if (failedReferences.length > 0) saveDraft(targetKey, removeImageReferenceTokensFromText(loadDraft(targetKey), failedReferences));
      return;
    }
    if (generation !== this.draftGeneration) return;
    this.pendingImageReferences = this.pendingImageReferences.filter((reference) => !references.includes(reference));
    if (additions.length > 0) this.attachments = [...this.attachments, ...additions].sort((a, b) => attachmentIdSequence(a.id) - attachmentIdSequence(b.id));
    for (const reference of failedReferences) this.removeImageReferenceTokens(reference);
    if (failed) this.attachmentError = READ_FAILURE_MESSAGE;
    else if (this.attachmentError === "Wait for image attachments to finish loading.") this.attachmentError = undefined;
    this.saveCurrentStaging();
  }

  private insertImageReferenceTokens(references: readonly string[], position: number): void {
    const insertion = imageReferenceInsertion(this.draft, position, references);
    this.dispatchDraftChange(position, position, insertion);
  }

  private removeImageReferenceTokens(reference: string): void {
    const text = removeImageReferenceTokensFromText(this.draft, [reference]);
    if (text === this.draft) return;
    const editor = this.editor;
    if (editor !== undefined) {
      editor.dispatch({
        changes: { from: 0, to: this.draft.length, insert: text },
        selection: EditorSelection.cursor(Math.min(editor.state.selection.main.head, text.length)),
      });
      return;
    }
    this.updateDraft(text);
  }

  private dispatchDraftChange(from: number, to: number, insert: string): void {
    const editor = this.editor;
    if (editor !== undefined) {
      editor.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length) });
      return;
    }
    this.updateDraft(`${this.draft.slice(0, from)}${insert}${this.draft.slice(to)}`);
  }

  private stagedAttachmentDraft() {
    return {
      attachments: this.attachments,
      nextImageReference: this.nextImageReference,
      pendingImageReferences: this.pendingImageReferences,
      generation: this.draftGeneration,
    };
  }

  private saveCurrentStaging(): void {
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) saveStagedAttachments(key, this.stagedAttachmentDraft());
  }

  private currentAttachments(): PromptAttachment[] {
    return this.attachments.map((attachment) => pendingToPromptAttachment(attachment));
  }

  private effectiveAttachmentDelivery(): PromptAttachmentDelivery {
    return effectivePromptAttachmentDelivery(this.attachmentDelivery, this.attachments);
  }

  private createEditor() {
    if (!this.editorHost || this.editor !== undefined) return;
    this.editor = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({
        doc: this.draft,
        extensions: [
          history(),
          markdown(),
          indentOnInput(),
          indentUnit.of("  "),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          drawSelection(),
          EditorView.contentAttributes.of((view) => inputAssistanceContentAttributes(view.state.sliceDoc(0, view.state.selection.main.head))),
          EditorView.domEventHandlers({
            keyup: (event) => this.handleEditorKeyUp(event),
            blur: () => this.resetEditorModifierState(),
          }),
          placeholder("Message pi... Use / for commands, @ for tracked files, @ space for all files, # for models"),
          promptArgumentHintExtension,
          this.editableCompartment.of(EditorView.editable.of(!this.disabled)),
          this.readOnlyCompartment.of(EditorState.readOnly.of(this.disabled)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.updateDraft(update.state.doc.toString());
            else if (update.selectionSet) void this.refreshCompletions();
          }),
          keymap.of([
            { any: (view, event) => this.handleEditorKeyDown(event, view) },
            { key: "ArrowDown", run: () => this.moveCompletion(1) },
            { key: "ArrowUp", run: () => this.moveCompletion(-1) },
            { key: "Escape", run: () => this.closeCompletions() },
            { key: "Tab", run: (view) => this.handleEditorTab(view) },
            { key: "Shift-Tab", run: (view) => indentWithTab.shift?.(view) ?? false },
            { key: "Backspace", run: (view) => deleteMarkupBackward(view) },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
        ],
      }),
    });
  }

  private syncEditorDoc() {
    const editor = this.editor;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === this.draft) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: this.draft },
      selection: EditorSelection.cursor(this.draft.length),
    });
  }

  private updateEditorDisabledState() {
    this.editor?.dispatch({
      effects: [
        this.editableCompartment.reconfigure(EditorView.editable.of(!this.disabled)),
        this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(this.disabled)),
      ],
    });
  }

  private updateDraft(value: string) {
    this.draft = value;
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) saveDraft(key, this.draft);
    const nextInputMode = inputModeForDraft(this.draft);
    if (!inputModesEqual(nextInputMode, this.currentInputMode)) this.currentInputMode = nextInputMode;
    void this.refreshCompletions();
  }

  private async refreshCompletions() {
    const trigger = this.currentTrigger();
    const triggerKey = completionTriggerKey(trigger);
    const version = ++this.requestVersion;
    this.completions = [];
    this.selectedIndex = 0;
    if (trigger === undefined) {
      this.setCompletions(version, triggerKey, []);
      return;
    }
    if (trigger.kind === "command" && this.sessionId !== undefined && this.sessionId !== "" && this.cwd !== undefined && this.cwd !== "") {
      const commands = await this.commandCatalog();
      if (version !== this.requestVersion) return;
      this.knownCommandNames = new Set(commands.map((command) => command.name));
      this.setCompletions(version, triggerKey, commands
        .filter((command) => command.name.toLowerCase().includes(trigger.query.toLowerCase()))
        .map((command) => ({
          kind: "command",
          replaceFrom: trigger.from,
          replaceTo: trigger.to,
          insertText: `/${command.name}`,
          detail: command.source,
          ...(command.description === undefined ? {} : { description: command.description }),
          ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
        })));
      return;
    }
    if (trigger.kind === "file" && this.projectId !== undefined && this.workspaceId !== undefined) {
      const files = await api.files(trigger.query, { scope: trigger.fileScope, machineId: this.machineId, projectId: this.projectId, workspaceId: this.workspaceId }).catch(emptyFileSuggestions);
      this.setCompletions(version, triggerKey, files
        .slice(0, 12)
        .map((file) => {
          const insertText = fileCompletionInsertText(file.path, trigger.quoted === true, file.path.endsWith("/") ? trigger.allPrefix : undefined);
          return {
            kind: "file",
            replaceFrom: trigger.from,
            replaceTo: trigger.to,
            insertText,
            detail: file.kind,
            ...(file.path.endsWith("/") && insertText.endsWith("\"") ? { cursorOffset: insertText.length - 1 } : {}),
          };
        }));
      return;
    }
    if (trigger.kind === "model" && this.sessionId !== undefined && this.sessionId !== "" && this.cwd !== undefined && this.cwd !== "") {
      const models = await api.models({ id: this.sessionId, cwd: this.cwd }, this.machineId).then((response) => response.models).catch(emptySessionModels);
      this.setCompletions(version, triggerKey, modelCompletionChoices(models, trigger.query).map((choice) => ({
        kind: "model",
        replaceFrom: trigger.from,
        replaceTo: trigger.to,
        ...choice,
      })));
      return;
    }
    this.setCompletions(version, triggerKey, []);
  }

  private setCompletions(version: number, trigger: string | undefined, completions: CompletionItem[]): void {
    if (version !== this.requestVersion) return;
    this.completionResultVersion = version;
    this.completionResultTrigger = trigger;
    this.completions = completions;
  }

  private commandCatalog(): Promise<SlashCommand[]> {
    if (this.commandCatalogRequest !== undefined) return this.commandCatalogRequest;
    if (this.sessionId === undefined || this.sessionId === "" || this.cwd === undefined || this.cwd === "") return Promise.resolve([]);
    this.commandCatalogRequest = api.commands({ id: this.sessionId, cwd: this.cwd }, this.machineId).catch(emptySlashCommands);
    return this.commandCatalogRequest;
  }

  private async isLeadingCommandDraft(draft: string): Promise<boolean> {
    if (isLeadingKnownCommandDraft(draft, this.knownCommandNames)) return true;
    if (leadingSlashCommandName(draft) === undefined) return false;
    const commands = await this.commandCatalog();
    this.knownCommandNames = new Set(commands.map((command) => command.name));
    return isLeadingKnownCommandDraft(draft, this.knownCommandNames);
  }

  private currentTrigger(): PromptCompletionTrigger | undefined {
    return detectPromptCompletionTrigger(this.draft, this.editor?.state.selection.main.head ?? this.draft.length);
  }

  private moveCompletion(delta: number): boolean {
    const completions = this.currentCompletions();
    if (!completions.length) return false;
    this.selectedIndex = (this.selectedIndex + delta + completions.length) % completions.length;
    return true;
  }

  private closeCompletions(): boolean {
    const wasOpen = this.currentCompletions().length > 0;
    this.requestVersion += 1;
    this.completions = [];
    return wasOpen;
  }

  /** The capture-phase app dispatcher must leave composer-owned keys to CodeMirror. */
  ownsKeyboardEvent(event: KeyboardEvent): boolean {
    if (this.editor === undefined || !event.composedPath().includes(this.editor.contentDOM)) return false;
    // Keep Enter/newline handling and IME composition inside the editor, too.
    return event.isComposing || this.editor.composing
      || (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey)
      || (isPrimaryModifierEnter(event) && composerKeyboardSubmissionEnabled(this.shortcuts, this.mobilePromptEnterMedia))
      || this.matchesSendShortcut(event);
  }

  private matchesSendShortcut(event: KeyboardEvent): boolean {
    const shiftKey = event.key === "Enter"
      ? shouldUsePromptEnterShiftShortcut(event.shiftKey, this.explicitShiftKeyActive, this.mobilePromptEnterMedia)
      : event.shiftKey;
    return matchesComposerSend({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey, isComposing: event.isComposing, target: event.target }, composerSendShortcut(this.shortcuts, this.mobilePromptEnterMedia));
  }

  private handleEditorKeyDown(event: KeyboardEvent, view: EditorView): boolean {
    if (event.key === "Shift") {
      this.explicitShiftKeyActive = true;
      return false;
    }
    if (!event.shiftKey) this.explicitShiftKeyActive = false;
    if (event.defaultPrevented || event.isComposing || view.composing) return false;
    const primaryModifierEnter = isPrimaryModifierEnter(event);
    const send = this.matchesSendShortcut(event);
    const plainEnter = event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey
      && !shouldUsePromptEnterShiftShortcut(event.shiftKey, this.explicitShiftKeyActive, this.mobilePromptEnterMedia);
    const completion = this.selectedCompletion();
    if (plainEnter && completion !== undefined) {
      this.pick(completion);
      return true;
    }
    if (primaryModifierEnter && composerKeyboardSubmissionEnabled(this.shortcuts, this.mobilePromptEnterMedia)) {
      void this.send(promptStreamingBehaviorForEnter(this.canSteer, this.isCompacting, true));
      return true;
    }
    if (send) {
      void this.send(promptStreamingBehaviorForEnter(this.canSteer, this.isCompacting, false));
      return true;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
    }
    return false;
  }

  private handleEditorKeyUp(event: KeyboardEvent): boolean {
    if (event.key === "Shift") this.explicitShiftKeyActive = false;
    return false;
  }

  private resetEditorModifierState(): boolean {
    this.explicitShiftKeyActive = false;
    return false;
  }


  private handleEditorTab(view: EditorView): boolean {
    const completion = this.selectedCompletion();
    if (completion !== undefined) {
      this.pick(completion);
      return true;
    }
    const trigger = this.currentTrigger();
    if (trigger?.kind === "file") {
      void this.refreshCompletions();
      return true;
    }
    return indentWithTab.run?.(view) ?? false;
  }

  private selectedCompletion(): CompletionItem | undefined {
    return this.currentCompletions()[this.selectedIndex];
  }

  private currentCompletions(): CompletionItem[] {
    return this.completionsAreCurrent() ? this.completions : [];
  }

  private completionsAreCurrent(): boolean {
    return this.completionResultVersion === this.requestVersion
      && this.completionResultTrigger === completionTriggerKey(this.currentTrigger());
  }

  private pick(item: CompletionItem) {
    const editor = this.editor;
    if (!editor || !this.completionsAreCurrent() || !this.completions.includes(item)) return;
    const suffix = item.kind === "file" && (item.insertText.endsWith("/") || item.cursorOffset !== undefined) ? "" : " ";
    const cursor = item.replaceFrom + (item.cursorOffset ?? item.insertText.length) + suffix.length;
    const replaceTo = item.insertText.endsWith("\"") && this.draft.slice(item.replaceTo).startsWith("\"") ? item.replaceTo + 1 : item.replaceTo;
    editor.dispatch({
      changes: { from: item.replaceFrom, to: replaceTo, insert: `${item.insertText}${suffix}` },
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
      ...(item.argumentHint === undefined || item.argumentHint === "" ? {} : { effects: setPromptArgumentHint.of({ pos: cursor, text: item.argumentHint }) }),
    });
    this.completions = [];
  }

  private async send(streamingBehavior?: "steer" | "followUp") {
    if (this.disabled || this.sending) return;
    if (this.pendingImageReferences.length > 0) {
      this.attachmentError = "Wait for image attachments to finish loading.";
      return;
    }
    if (leadingSlashCommandName(this.draft) !== undefined) await this.isLeadingCommandDraft(this.draft);
    if (this.sendBecameBlocked()) return;
    const commandMode = isLeadingKnownCommandDraft(this.draft, this.knownCommandNames);
    const pending = this.attachments;
    const attachments = pending.length > 0 ? this.currentAttachments() : undefined;
    const references = attachments?.flatMap((attachment) => attachment.kind === "image" ? [attachment.reference] : []) ?? [];
    const text = (commandMode ? removeImageReferenceTokensFromText(this.draft, references) : this.draft).trim();
    if (text === "" && pending.length === 0) return;
    const behavior = this.canSteer || this.isCompacting ? streamingBehavior : undefined;
    const delivery = this.effectiveAttachmentDelivery();
    // Folder delivery sends the displayed workspace-effective folder explicitly
    // (the uploads pattern): the save lands exactly where the label pointed,
    // independent of how the session cwd would resolve its own project config.
    const folder = attachments !== undefined && delivery === "folder" ? this.attachmentsFolder : undefined;
    const snapshot = this.composerSnapshot();
    this.resetComposer();
    const resetGeneration = this.draftGeneration;
    void this.deliverComposer(snapshot, resetGeneration, text, behavior, attachments, attachments === undefined ? undefined : delivery, folder);
  }

  private sendBecameBlocked(): boolean {
    if (this.pendingImageReferences.length > 0) this.attachmentError = "Wait for image attachments to finish loading.";
    return this.disabled || this.sending || this.pendingImageReferences.length > 0;
  }

  private composerSnapshot() {
    return {
      key: draftStorageKey(this.machineId, this.sessionId),
      draft: this.draft,
      attachments: this.attachments,
      nextImageReference: this.nextImageReference,
      pendingImageReferences: this.pendingImageReferences,
      generation: this.draftGeneration,
      cursor: this.editor?.state.selection.main.head ?? this.draft.length,
    };
  }

  private async deliverComposer(
    snapshot: ReturnType<PromptEditor["composerSnapshot"]>,
    resetGeneration: number,
    text: string,
    behavior: "steer" | "followUp" | undefined,
    attachments: PromptAttachment[] | undefined,
    delivery: PromptAttachmentDelivery | undefined,
    folder: string | undefined,
  ): Promise<void> {
    try {
      const delivered = await this.onSend?.(text, behavior, attachments, delivery, folder);
      if (delivered !== false) return;
    } catch {
      // The controller owns the visible request error; the composer owns retry state.
    }
    this.restoreComposer(snapshot, resetGeneration);
  }

  private restoreComposer(snapshot: ReturnType<PromptEditor["composerSnapshot"]>, resetGeneration: number): void {
    const key = snapshot.key === undefined ? undefined : resolveStagedAttachmentKey(snapshot.key);
    if (key !== undefined) {
      saveDraft(key, snapshot.draft);
      saveStagedAttachments(key, {
        attachments: snapshot.attachments,
        nextImageReference: snapshot.nextImageReference,
        pendingImageReferences: snapshot.pendingImageReferences,
        generation: snapshot.generation,
      });
    }
    if (key !== draftStorageKey(this.machineId, this.sessionId) || this.draftGeneration !== resetGeneration) return;
    this.draft = snapshot.draft;
    this.attachments = snapshot.attachments;
    this.nextImageReference = snapshot.nextImageReference;
    this.pendingImageReferences = snapshot.pendingImageReferences;
    this.draftGeneration = snapshot.generation;
    this.currentInputMode = inputModeForDraft(snapshot.draft);
    this.attachmentError = "Attachment delivery failed. Draft restored for retry.";
    const editor = this.editor;
    if (editor !== undefined) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: snapshot.draft },
        selection: EditorSelection.cursor(Math.min(snapshot.cursor, snapshot.draft.length)),
      });
    }
  }

  private resetComposer() {
    this.draft = "";
    this.currentInputMode = { kind: "normal" };
    this.requestVersion += 1;
    const key = draftStorageKey(this.machineId, this.sessionId);
    this.draftGeneration += 1;
    if (key !== undefined) {
      clearDraft(key);
      clearStagedAttachments(key);
    }
    this.completions = [];
    this.attachments = [];
    this.nextImageReference = 1;
    this.pendingImageReferences = [];
    if (key !== undefined) saveStagedAttachments(key, this.stagedAttachmentDraft());
    this.attachmentError = undefined;
    // `draft` is not reactive, so the cleared text will not flow to CodeMirror
    // via `updated()`; push it to the editor document explicitly.
    this.syncEditorDoc();
  }

  static override styles = promptEditorStyles;
}

// Compare only status fields rendered by PromptEditor so unrelated streaming
// churn does not disturb the editor DOM or an in-progress touch gesture.
function sessionStatusRenderEqual(a: SessionStatus | undefined, b: SessionStatus | undefined, showUsage: boolean): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.model?.id !== b.model?.id
    || a.model?.provider !== b.model?.provider
    || a.thinkingLevel !== b.thinkingLevel
    || a.extensionStatuses?.[WORKING_MODE_STATUS_KEY] !== b.extensionStatuses?.[WORKING_MODE_STATUS_KEY]) return false;
  return !showUsage || (a.tokens.input === b.tokens.input
    && a.tokens.output === b.tokens.output
    && a.contextUsage?.tokens === b.contextUsage?.tokens
    && a.contextUsage?.contextWindow === b.contextUsage?.contextWindow
    && a.contextUsage?.percent === b.contextUsage?.percent
    && a.cost === b.cost
    && a.pendingMessageCount === b.pendingMessageCount);
}

function completionTriggerKey(trigger: PromptCompletionTrigger | undefined): string | undefined {
  return trigger === undefined ? undefined : JSON.stringify(trigger);
}

function isPrimaryModifierEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.altKey && !event.shiftKey && (event.ctrlKey || event.metaKey);
}

function draftStorageKey(machineId: unknown, sessionId: unknown): string | undefined {
  if (typeof machineId !== "string" || machineId === "") return undefined;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  return machineSessionKey(machineId, sessionId);
}

function emptySlashCommands(): SlashCommand[] {
  return [];
}

function emptyFileSuggestions(): FileSuggestion[] {
  return [];
}

function emptySessionModels(): SessionModel[] {
  return [];
}

function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (data === null) return [];
  return Array.from(data.files);
}

function dataTransferHasFiles(data: DataTransfer): boolean {
  const items = Array.from(data.items);
  if (items.length > 0) return items.some((item) => item.kind === "file");
  return Array.from(data.types).includes("Files");
}

export function sanitizeDraftImageReferences(text: string, attachments: readonly { kind: string; reference?: string }[], pendingReferences: readonly string[] = []): string {
  const references = new Set([...pendingReferences, ...attachments.flatMap((attachment) => attachment.kind === "image" ? [attachment.reference] : [])]);
  const dangling = Array.from(text.matchAll(/\[PIC_[1-9]\d*\]/g), (match) => match[0]).filter((reference) => !references.has(reference));
  return removeImageReferenceTokensFromText(text, dangling);
}

export function isLeadingKnownCommandDraft(draft: string, knownCommandNames: ReadonlySet<string>): boolean {
  const name = leadingSlashCommandName(draft);
  return name !== undefined && knownCommandNames.has(name);
}

function leadingSlashCommandName(draft: string): string | undefined {
  const match = /^\/([^\s]+)(?:\s|$)/.exec(draft);
  if (match?.[1] === undefined || inputModeForDraft(match[0].trim()).kind !== "command") return undefined;
  return match[1];
}

export function imageReferenceInsertion(text: string, position: number, references: readonly string[]): string {
  if (references.length === 0) return "";
  const prefix = position > 0 && !/\s/.test(text[position - 1] ?? "") ? " " : "";
  const suffix = position >= text.length || !/\s/.test(text[position] ?? "") ? " " : "";
  return `${prefix}${references.join(" ")}${suffix}`;
}

export function removeImageReferenceTokensFromText(text: string, references: readonly string[]): string {
  return references.reduce((current, reference) => current
    .replaceAll(`${reference} `, "")
    .replaceAll(` ${reference}`, "")
    .replaceAll(reference, ""), text);
}

function isSupportedImageFile(file: File): boolean {
  return isSupportedImageMimeType(file.type);
}

function attachmentIdSequence(id: string): number {
  const sequence = Number(id.slice(id.lastIndexOf("-") + 1));
  return Number.isFinite(sequence) ? sequence : 0;
}

function pendingToPromptAttachment(attachment: PendingAttachment): PromptAttachment {
  if (attachment.kind === "image") {
    return { kind: "image", reference: attachment.reference, mimeType: attachment.mimeType, data: attachment.data, name: attachment.name };
  }
  return { kind: "file", mimeType: attachment.mimeType, data: attachment.data, name: attachment.name };
}

export function attachmentFolderDeliveryLabel(folder: string): string {
  return `Save to ${folder}`;
}

function fileExtensionLabel(name: string): string {
  const trimmed = name.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex >= 0 && dotIndex < trimmed.length - 1) return trimmed.slice(dotIndex + 1, dotIndex + 5).toUpperCase();
  return "FILE";
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(reader.error ?? new Error("Failed to read file")); };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") { reject(new Error("Unexpected file reader result")); return; }
      const commaIndex = result.indexOf(",");
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
    };
    reader.readAsDataURL(file);
  });
}

const proseInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "true",
  autocorrect: "on",
  autocapitalize: "sentences",
  writingsuggestions: "true",
  dir: "auto",
};

const codeLikeInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  writingsuggestions: "false",
  dir: "auto",
};

function inputAssistanceContentAttributes(draftBeforeCursor: string): Record<string, string> {
  // CodeMirror is optimized for code and disables these by default, but the chat prompt is usually prose.
  return inputModeForDraft(draftBeforeCursor).kind === "normal" ? proseInputAssistanceAttributes : codeLikeInputAssistanceAttributes;
}

