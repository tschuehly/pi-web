import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { cache } from "lit/directives/cache.js";
import { MessageActionsMenu } from "./chat/MessageActionsMenu";
import { renderSessionWarningIcon } from "./shared";
import { chatToolOutputLabel } from "./chat/transcriptLabels";
import { chatMessageHasHeader, isQuietNotice, splitNoticeText, summarizeChatGroup, type ChatDisplayGroup, type ChatGroup } from "../chatGroups";
import { latestWorkingModeDials, previewFromDetails, workingModeSummary } from "../chatMessages";
import { writeClipboardText } from "../clipboard";
import { toolActionLabel } from "./ToolExecutionView";
import { renderDisclosureChevron } from "./tabIcons";
import "./BashLogButton";
import type { ChatBehaviors } from "../chatBehaviors";
import type { SessionRef } from "../api";
import type { ChatContentRendering } from "../formatting/contentRendering";
import type { MarkdownWorkspaceContext } from "../formatting/workspaceLinks";
import type { ChatLine, ChatPart, GoalLifecycleDetails } from "../chatTypes";
import type { ImageOpenDetail } from "./ImagePresentation";
import type { ChatMessageActionController } from "./ChatMessageActionController";

const goalTransitionLabels: Record<GoalLifecycleDetails["transition"], string> = {
  start: "Goal started", resume: "Goal resumed", pause: "Goal paused", wait: "Goal waiting",
  block: "Goal blocked", usage_limit: "Goal usage limited", budget_limit: "Goal budget limited",
  complete: "Goal completed", clear: "Goal cleared",
};

export interface TranscriptGroupDisclosure {
  open: boolean;
  anchor: string | undefined;
  toggle: ((event: Event) => void) | undefined;
}

/** Data and narrow interaction boundaries; templates share ChatView's shadow root. */
export interface TranscriptRenderContext {
  machineId: string;
  sessionId: string;
  session: SessionRef;
  messages: readonly ChatLine[];
  messageStart: number;
  behaviors: ChatBehaviors;
  contentRendering: ChatContentRendering | undefined;
  workspaceContext: MarkdownWorkspaceContext | undefined;
  anchors: {
    message: (index: number, message: ChatLine) => string | undefined;
    event: (index: number, message: ChatLine) => string | undefined;
  };
  disclosure: {
    isOpen: (key: string, defaultOpen: boolean) => boolean;
    toggle: (key: string, event: Event, defaultOpen: boolean) => void;
  };
  metadata: {
    expandedKey: string | undefined;
    label: (message: ChatLine) => string;
    expand: (key: string | undefined) => void;
  };
  actions: ChatMessageActionController;
  askDraftSessionId: string;
  openImageGallery: (images: readonly { part: Extract<ChatPart, { type: "image" }>; description: string }[], selectedIndex: number) => void;
}

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Workbench bubble heading: the role and the message's time inline; ChatView shows it only in the Workbench presentation. */
function renderMessageHeading(context: TranscriptRenderContext, message: ChatLine) {
  const timestamp = message.meta?.timestamp;
  const date = timestamp === undefined ? undefined : new Date(timestamp);
  const time = date === undefined || !Number.isFinite(date.getTime()) ? undefined : messageTimeFormatter.format(date);
  return html`<div class="msg-heading"><b class="msg-role" aria-hidden="true">${message.role}</b>${time === undefined ? nothing : html`<time class="msg-time" datetime=${timestamp ?? nothing} title=${context.metadata.label(message)}>${time}</time>`}</div>`;
}

/** One quiet line; a multi-line notice expands to show the rest. */
function renderNotice(context: TranscriptRenderContext, message: ChatLine, index: number) {
  const { first, rest } = splitNoticeText(message);
  const formatted = (text: string) => html`<formatted-text .intentKey=${JSON.stringify([context.machineId, context.sessionId, message.entryId ?? index, "notice"])} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${text}></formatted-text>`;
  if (rest === "") return html`<div class="notice" dir="auto">${formatted(first)}</div>`;
  return html`<details class="notice"><summary>${renderDisclosureChevron()}<span class="disclosure-preview" dir="auto">${first}</span></summary>${formatted(rest)}</details>`;
}

export function renderMessage(context: TranscriptRenderContext, message: ChatLine, index: number, entryActionHeaders: ReadonlySet<ChatLine>) {
    if (isQuietNotice(message)) return html`
      <article class=${`msg system notice-line${message.severity === undefined ? "" : ` ${message.severity}`}`} data-index=${index} data-scroll-anchor-id=${context.anchors.message(index, message) ?? nothing} data-entry-id=${message.entryId ?? nothing}>${renderNotice(context, message, index)}</article>
    `;
    const hasHeader = chatMessageHasHeader(message);
    const conversationClass = hasHeader && (message.role === "user" || message.role === "assistant") ? " conversation-message conversation-layout" : "";
    const severity = message.severity === undefined ? "" : ` ${message.severity}`;
    return html`
      <article class=${`${hasHeader ? `msg ${message.role}${conversationClass}` : headerlessShellClass(message)}${severity} ui-transcript-surface`} data-index=${index} data-scroll-anchor-id=${context.anchors.message(index, message) ?? nothing} data-entry-id=${message.entryId ?? nothing}>
        ${conversationClass !== "" ? html`
          <div class="conversation-content">
            ${renderMessageHeader(context, message, String(index), index, entryActionHeaders, message.role, true)}
            <div class="conversation-body">${renderMessageHeading(context, message)}${message.parts.map((part, partIndex) => renderPart(context, part, message, index, partIndex))}</div>
          </div>
          ${renderMessageMetadata(context, message, String(index))}
        ` : html`
          ${hasHeader ? renderMessageHeader(context, message, String(index), index, entryActionHeaders) : null}
          ${message.parts.map((part, partIndex) => renderPart(context, part, message, index, partIndex))}
        `}
      </article>
    `;
  }


export function renderToolImageOutputs(context: TranscriptRenderContext, group: Extract<ChatDisplayGroup, { kind: "tool-images" }>, entryActionHeaders: ReadonlySet<ChatLine>) {
    const { outputs } = group;
    const first = outputs[0];
    const sourcesKey = `image-sources:${JSON.stringify([context.machineId, context.sessionId, first.message.entryId ?? first.index])}`;
    const sourcesOpen = context.disclosure.isOpen(sourcesKey, false);
    const label = chatToolOutputLabel(outputs.every((output) => output.toolName === first.toolName) ? first.toolName : undefined);
    const parts = outputs.flatMap((output, outputIndex) => output.message.parts.flatMap((part, partIndex) => part.type !== "image" ? [] : [{
      part, output, anchor: outputIndex > 0 && partIndex === 0 ? context.anchors.message(output.index, output.message) : undefined,
    }]));
    const images = parts.map((image, imageIndex) => ({ ...image,
      description: `${chatToolOutputLabel(image.output.toolName)} image ${String(imageIndex + 1)} of ${String(parts.length)}`,
    }));
    return html`
      <article class="msg tool-image-output conversation-message ui-transcript-surface" data-index=${first.index} data-scroll-anchor-id=${context.anchors.message(first.index, first.message) ?? nothing}>
        ${outputs.length === 1 ? renderMessageHeader(context, first.message, String(first.index), first.index, entryActionHeaders, label) : html`<div class="msg-header"><span class="label">${label}</span></div>`}
        <div class="tool-image-thumbnails">
          ${images.map((image, imageIndex) => html`
            <pi-web-transcript-image .imagePart=${image.part} .thumbnail=${true} .description=${image.description}
              data-index=${image.output.index} data-scroll-anchor-id=${image.anchor ?? nothing}
              .loadingDisabled=${!context.behaviors.loadImages} .session=${context.session} .machineId=${context.machineId}
              @image-open=${(event: CustomEvent<ImageOpenDetail>) => { event.stopPropagation(); context.openImageGallery(images, imageIndex); }}
            ></pi-web-transcript-image>
          `)}
        </div>
        ${outputs.length === 1 ? null : html`
          <details class="image-output-sources" ?open=${live(sourcesOpen)} @toggle=${(event: Event) => { context.disclosure.toggle(sourcesKey, event, false); }}>
            <summary class="ui-transcript-disclosure">${renderDisclosureChevron()}Sources (${String(outputs.length)})</summary>
            ${sourcesOpen ? outputs.map((output, outputIndex) => html`<section class="image-output-source" aria-label=${`Output ${String(outputIndex + 1)}`}>
              ${renderMessageHeader(context, output.message, `image-source:${String(output.index)}`, output.index, entryActionHeaders, `${chatToolOutputLabel(output.toolName)} · ${String(outputIndex + 1)}`)}
            </section>`) : nothing}
          </details>
        `}
      </article>
    `;
  }


function headerlessShellClass(message: ChatLine): string {
  const only = (type: ChatPart["type"]) => message.parts.length > 0 && message.parts.every((part) => part.type === type);
  if (only("toolExecution")) return "msg tool-execution-shell";
  if (only("askUserRecord")) return "msg ask-user-record-shell";
  if (only("subagentCompletion")) return "msg subagent-completion-shell";
  if (only("skillRead")) return "msg skill-read-shell";
  return "msg goal-lifecycle-shell";
}


// Detached cached bodies retain nested native/tool state without rendering while closed.
// Routine activity folds away; failures and material writes (no presentation) stay visible.
export function renderMessageGroup(context: TranscriptRenderContext, group: Extract<ChatGroup, { kind: "group" }>, defaultOpen: boolean, entryActionHeaders: ReadonlySet<ChatLine>, disclosure: TranscriptGroupDisclosure) {
    const { messages, startIndex, presentation } = group;
    const { open, anchor, toggle } = disclosure;
    // One routine step needs no "Activity · 1 step" fold; its own row says what ran (ISSUE-101).
    if (presentation === undefined || (presentation === "activity" && activityStepCount(messages.map((event) => event.message)) === 1)) return html`
      <div class="event-group visible-events" data-index=${startIndex} data-scroll-anchor-id=${anchor ?? nothing}>${renderMessageGroupBody(context, group, entryActionHeaders)}</div>
    `;
    if (presentation === "thinking") return renderThinkingGroup(context, group, entryActionHeaders, disclosure);
    if (presentation === "notices") return html`
      <details class="event-group notice-fold" data-index=${startIndex} data-scroll-anchor-id=${anchor ?? nothing} ?open=${open} @toggle=${toggle}>
        <summary>${renderDisclosureChevron()}<span class="notice-fold-count">${messages.length} notices</span><span class="disclosure-preview" dir="auto">${messages.map((event) => splitNoticeText(event.message)).at(-1)?.first}</span></summary>
        ${renderMessageGroupBody(context, group, entryActionHeaders)}
      </details>
    `;
    const summary = presentation === "history"
      ? html`<strong>${summarizeChatGroup(messages.map((event) => event.message))}</strong><span class="group-note">Context compacted</span>`
      : html`<strong>Activity</strong><span>${activityStepLabel(messages.map((event) => event.message))}</span>`;
    return html`
      <details class=${`msg event-group ${presentation}-group${defaultOpen ? " live" : ""} ui-transcript-surface ui-transcript-activity`} data-index=${startIndex} data-scroll-anchor-id=${anchor ?? nothing} ?open=${open} @toggle=${toggle}>
        <summary class="ui-transcript-disclosure ui-transcript-heading">${renderDisclosureChevron()}${summary}</summary>
        ${cache(open ? renderMessageGroupBody(context, group, entryActionHeaders) : nothing)}
      </details>
    `;
  }

/** Reasoning stays readable; routine tool calls between its paragraphs fold to one line that still says when one runs. */
function renderThinkingGroup(context: TranscriptRenderContext, group: Extract<ChatGroup, { kind: "group" }>, entryActionHeaders: ReadonlySet<ChatLine>, disclosure: TranscriptGroupDisclosure) {
  const { open, anchor, toggle } = disclosure;
  const segments: { kind: "thinking" | "skill" | "activity"; members: Extract<ChatGroup, { kind: "group" }>["messages"] }[] = [];
  for (const member of group.messages) {
    const kind = member.message.parts.every((part) => part.type === "thinking") ? "thinking"
      : member.message.parts.every((part) => part.type === "skillRead") ? "skill" : "activity";
    const previous = segments.at(-1);
    if (previous?.kind === kind) previous.members.push(member);
    else segments.push({ kind, members: [member] });
  }
  return html`
    <details class="msg event-group thinking-group thinking ui-transcript-surface ui-transcript-activity" data-index=${group.startIndex} data-scroll-anchor-id=${anchor ?? nothing} ?open=${open} @toggle=${toggle}>
      <summary class="ui-transcript-disclosure ui-transcript-heading">${renderDisclosureChevron()}Thinking</summary>
      ${cache(open ? segments.map((segment, offset) => {
        const body = { ...group, messages: segment.members };
        if (segment.kind === "thinking") {
          const text = segment.members.flatMap(({ message }) => message.parts)
            .flatMap((part) => part.type === "thinking" ? [part.displayText ?? part.text] : [])
            .filter((partText) => partText !== "").join("\n\n");
          const intentKey = JSON.stringify([context.machineId, context.sessionId, "thinking", group.startIndex, offset]);
          return html`<formatted-text class="thinking-text" .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${text}></formatted-text>`;
        }
        if (segment.kind === "skill") return renderMessageGroupBody(context, body, entryActionHeaders);
        return renderToolFold(context, body, entryActionHeaders);
      }) : nothing)}
    </details>
  `;
}

function renderToolFold(context: TranscriptRenderContext, group: Extract<ChatGroup, { kind: "group" }>, entryActionHeaders: ReadonlySet<ChatLine>) {
  const lines = group.messages.map((event) => event.message);
  const running = lines.flatMap((line) => line.parts).some((part) => part.type === "toolExecution" && (part.status === "running" || part.status === "pending"));
  const key = `tool-fold:${JSON.stringify([context.machineId, context.sessionId, group.messages[0]?.message.entryId ?? group.messages[0]?.index])}`;
  const open = context.disclosure.isOpen(key, false);
  return html`
    <details class="tool-fold" ?open=${live(open)} @toggle=${(event: Event) => { context.disclosure.toggle(key, event, false); }}>
      <summary>${renderDisclosureChevron()}${activityStepLabel(lines, "tool call")}${running ? html` · <span class="running">running</span>` : null}</summary>
      ${open ? renderMessageGroupBody(context, group, entryActionHeaders) : nothing}
    </details>
  `;
}

/** Calls and their results count once per tool call id. */
function activityStepLabel(messages: readonly ChatLine[], noun = "step"): string {
  const count = activityStepCount(messages);
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function activityStepCount(messages: readonly ChatLine[]): number {
  const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "toolCall" || part.type === "toolExecution" || part.type === "toolResult");
  const ids = new Set(parts.flatMap((part) => part.toolCallId === undefined ? [] : [part.toolCallId]));
  const anonymous = parts.filter((part) => part.toolCallId === undefined && part.type !== "toolResult").length;
  return ids.size + anonymous;
}


export function renderMessageGroupBody(context: TranscriptRenderContext, { messages, startIndex }: Extract<ChatGroup, { kind: "group" }>, entryActionHeaders: ReadonlySet<ChatLine> = new Set()) {
    return html`
      <div class="group-body">
        ${messages.map(({ message, index }, offset) => {
          const severity = message.severity === undefined ? "" : ` ${message.severity}`;
          if (isQuietNotice(message)) return html`
            <article class=${`group-msg system notice-line${severity}`} data-index=${index} data-scroll-anchor-id=${context.anchors.event(index, message) ?? nothing} data-entry-id=${message.entryId ?? nothing}>${renderNotice(context, message, index)}</article>`;
          return html`
            <section class=${`group-msg ${message.role}${severity} ui-transcript-surface`} data-index=${index} data-scroll-anchor-id=${context.anchors.event(index, message) ?? nothing} data-entry-id=${message.entryId ?? nothing}>
              ${chatMessageHasHeader(message) ? html`<div class="transcript-content">${renderMessageHeader(context, message, `${String(startIndex)}:${String(offset)}`, index, entryActionHeaders)}</div>` : null}
              ${renderGroupedParts(context, message, index)}
            </section>`;
        })}
      </div>
    `;
  }


/** Sections own their body inset; only consecutive ordinary content shares outer padding. */
function renderGroupedParts(context: TranscriptRenderContext, message: ChatLine, messageIndex: number) {
  const runs: { section: boolean; parts: { part: ChatPart; index: number }[] }[] = [];
  message.parts.forEach((part, index) => {
    if ((part.type === "text" || part.type === "thinking") && (part.displayText ?? part.text) === "") return;
    const section = part.type === "thinking" || part.type === "toolCall" || part.type === "toolResult"
      || part.type === "toolExecution" || part.type === "askUserRecord";
    const previous = runs.at(-1);
    if (!section && previous !== undefined && !previous.section) previous.parts.push({ part, index });
    else runs.push({ section, parts: [{ part, index }] });
  });
  return runs.map((run) => html`
    <div class=${run.section ? "transcript-section" : "transcript-content"}>
      ${run.parts.map(({ part, index }) => renderPart(context, part, message, messageIndex, index))}
    </div>
  `);
}

export function renderMessageHeader(context: TranscriptRenderContext, message: ChatLine, key: string, index: number, entryActionHeaders: ReadonlySet<ChatLine>, label: string = message.role, metadataBelow = false) {
    const meta = context.metadata.label(message);
    const expanded = context.metadata.expandedKey === key;
    const detailId = `message-meta-${key}`;
    const conversation = label === "user" || label === "assistant";
    return html`
      <div class=${conversation ? "msg-header conversation-header" : "msg-header"}>
        <span class=${conversation ? "visually-hidden" : "label"}>${label}</span>
        <pi-message-actions-menu>
          <div class="msg-actions-strip">
            ${renderMessageActions(context, message, key, context.messages[index - context.messageStart] ?? message, entryActionHeaders.has(message))}
            <button type="button" class="msg-meta ui-button ui-button--icon ui-button--small" title=${meta} aria-label="Message information" aria-controls=${detailId} aria-expanded=${String(expanded)} @click=${(event: MouseEvent) => {
              context.metadata.expand(expanded ? undefined : key);
              const menu = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest("pi-message-actions-menu") : null;
              if (menu instanceof MessageActionsMenu) menu.close();
            }}>${renderSessionWarningIcon("info", "msg-info-icon")}</button>
          </div>
        </pi-message-actions-menu>
      </div>
      ${metadataBelow ? null : renderMessageMetadata(context, message, key)}
    `;
  }

function renderMessageMetadata(context: TranscriptRenderContext, message: ChatLine, key: string) {
  return html`<div id=${`message-meta-${key}`} class="msg-meta-details" ?hidden=${context.metadata.expandedKey !== key}>${context.metadata.label(message)}</div>`;
}

export function renderPart(context: TranscriptRenderContext, part: ChatPart, message: ChatLine, messageIndex: number, partIndex: number) {
    const intentKey = JSON.stringify([context.machineId, context.sessionId, message.entryId ?? messageIndex, partIndex]);
    if (part.type === "text" || part.type === "thinking") {
      const text = part.displayText ?? part.text;
      if (text === "") return null;
      if (part.type === "thinking") {
        const disclosureKey = `thinking:${intentKey}`;
        const open = context.disclosure.isOpen(disclosureKey, true);
        return html`
          <details class="part thinking ui-transcript-surface ui-transcript-activity" ?open=${live(open)}
            @toggle=${(event: Event) => { context.disclosure.toggle(disclosureKey, event, true); }}>
            <summary class="ui-transcript-disclosure ui-transcript-heading">${renderDisclosureChevron()}Thinking</summary>
            ${open ? html`<formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${text}></formatted-text>` : nothing}
          </details>
        `;
      }
      if (message.role === "bash") return html`<pre class="part shell-output">${text}</pre>`;
      return html`<formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} class="part" .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${text}></formatted-text>`;
    }
    if (part.type === "skillInvocation") {
      const key = `skill:${intentKey}`;
      const open = context.disclosure.isOpen(key, false);
      return html`
      <details class="part skill-invocation" ?open=${live(open)} @toggle=${(event: Event) => { context.disclosure.toggle(key, event, false); }}>
        <summary class="ui-transcript-disclosure">${renderDisclosureChevron()}<b>[skill]</b> ${part.name}</summary>
        ${open ? html`<small>${part.location}</small>
        <formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${part.content}></formatted-text>` : nothing}
      </details>
    `;
    }
    if (part.type === "skillRead") return html`<div class="part skill-read" title=${part.path}>Read skill · ${part.name}</div>`;
    if (part.type === "askUserRecord") return html`
      <ask-user-card
        class="part"
        .outcome=${part.outcome}
        .draftSessionId=${context.askDraftSessionId}
        .workspaceContext=${context.workspaceContext}
      ></ask-user-card>
    `;
    if (part.type === "subagentCompletion") return html`
      <details class="part subagent-completion">
        <summary>${renderDisclosureChevron()}Subagents finished</summary>
        <div class="subagent-completion-instruction" dir="auto">${part.text}</div>
      </details>
    `;
    if (part.type === "backgroundBash") return renderBackgroundBash(context, part);
    if (part.type === "workingMode") {
      // Grouping may copy the line, so locate it by its part.
      const index = context.messages.findIndex((line) => line.parts.includes(part));
      const summary = workingModeSummary(part.dials, index < 0 ? undefined : latestWorkingModeDials(context.messages, index));
      // Lucide sliders-horizontal.
      return html`
        <details class="part working-mode-card">
          <summary>${renderDisclosureChevron()}<span class="working-mode-summary">${summary}</span><svg class="working-mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10 5H3"></path><path d="M12 19H3"></path><path d="M14 3v4"></path><path d="M16 17v4"></path><path d="M21 12h-9"></path><path d="M21 19h-5"></path><path d="M21 5h-7"></path><path d="M8 10v4"></path><path d="M8 12H3"></path></svg></summary>
          ${part.dials.some((dial) => dial.guidance !== undefined)
            ? html`<dl>${part.dials.map((dial) => html`<dt>${dial.label} — ${dial.value}</dt><dd>${dial.guidance ?? "Starting setting; no extra guidance."}</dd>`)}</dl>`
            : html`<p>Every dial is at its starting setting; no extra guidance applies.</p>`}
        </details>
      `;
    }
    if (part.type === "goalLifecycle") return html`
      <details class="part goal-lifecycle">
        <summary>${renderDisclosureChevron()}${goalTransitionLabels[part.details.transition]}</summary>
        <div><strong>State:</strong> ${part.details.state}</div>
        <div><strong>Goal ID:</strong> <code>${part.details.goalId}</code></div>
        ${part.details.reason === undefined ? null : html`<div><strong>Reason:</strong> ${part.details.reason}</div>`}
        ${part.details.summary === undefined ? null : html`<div><strong>Summary:</strong> ${part.details.summary}</div>`}
      </details>
    `;
    if (part.type === "image") {
      return html`<pi-web-transcript-image class="part chat-image" .imagePart=${part} .loadingDisabled=${!context.behaviors.loadImages}
        .session=${context.session} .machineId=${context.machineId}
      ></pi-web-transcript-image>`;
    }
    if (part.type === "toolCall") return html`
      <details class="part tool-line ui-transcript-surface ui-transcript-activity ui-transcript-tool">
        <summary class="ui-transcript-disclosure ui-transcript-heading">${renderDisclosureChevron()}${toolActionLabel(part.toolName)}<span class="summary">${part.summary}</span></summary>
        ${part.args === undefined ? null : html`<pre class="tool-call-arguments">${formatToolCallArguments(part.args)}</pre>`}
      </details>
    `;
    if (part.type === "toolExecution") return html`<tool-execution-view class="part" data-status=${part.status} .machineId=${context.machineId} .execution=${part}></tool-execution-view>`;
    if (part.type === "toolResult") {
      // A result whose call is outside the loaded page still shows its file diff.
      const preview = previewFromDetails(part.details);
      if ((typeof part.details === "object" && part.details !== null && typeof Reflect.get(part.details, "diff") === "string") || preview?.diff !== undefined) return html`
        <tool-execution-view class="part" data-status=${part.isError ? "error" : "success"} .orphan=${true} .machineId=${context.machineId} .execution=${{
          type: "toolExecution", toolName: part.toolName, summary: "", status: part.isError ? "error" : "success",
          resultText: part.text, details: part.details, preview,
        }}></tool-execution-view>
      `;
      const key = `tool-result:${intentKey}`;
      const open = context.disclosure.isOpen(key, part.isError);
      return html`
      <details class=${`part tool-result ui-transcript-surface ui-transcript-activity ui-transcript-tool${part.isError ? " error" : ""}`} ?open=${live(open)} @toggle=${(event: Event) => { context.disclosure.toggle(key, event, part.isError); }}>
        <summary class="ui-transcript-disclosure ui-transcript-heading">${renderDisclosureChevron()}${toolActionLabel(part.toolName)} result${part.isError ? " · Failed" : ""} ${part.isError ? "✖" : "✓"}</summary>
        ${open ? html`<formatted-text .imagesEnabled=${context.behaviors.loadImages} .codeBlocks=${context.behaviors.codeBlocks} .intentKey=${intentKey} .contentRendering=${context.contentRendering} .machineId=${context.machineId} .workspaceContext=${context.workspaceContext} .text=${part.text}></formatted-text>` : nothing}
      </details>
    `;
    }
    return null;
  }


export function renderMessageActions(context: TranscriptRenderContext, message: ChatLine, key: string, source: ChatLine, includeEntryActions: boolean) {
  const actions = context.actions.available(source, message, includeEntryActions);
  if (actions.length === 0) return null;
  const error = context.actions.errorMessage(key);
  return html`
    <div class="msg-actions" aria-label="Message actions">
      ${actions.map(({ action, enabled, ariaLabel }) => {
        const presentation = context.actions.presentation(key, action.id);
        const icon = presentation?.icon ?? action.icon;
        return html`<button type="button" class=${`msg-action ui-button ui-button--small ${icon === undefined ? "" : "ui-button--icon"}`} title=${presentation?.title ?? action.title} aria-label=${presentation?.ariaLabel ?? presentation?.title ?? ariaLabel} ?disabled=${!enabled || context.actions.pending(key, action)} @click=${(event: MouseEvent) => { event.stopPropagation(); void context.actions.run(source, message, key, action); }}>${icon ?? action.title}</button>`;
      })}
      ${error === undefined ? null : html`<span role="alert">${error}</span>`}
    </div>
  `;
}

function renderBackgroundBash(context: TranscriptRenderContext, part: Extract<ChatPart, { type: "backgroundBash" }>) {
  const { details } = part;
  return html`
    <details class="part background-bash-card">
      <summary>${renderDisclosureChevron()}<span>${details.state} · exit ${details.exitCode === undefined ? "unknown" : String(details.exitCode)} · ${String(details.elapsedSeconds)}s</span>
        <span aria-hidden="true">${details.state === "complete" ? "✓" : details.state === "cancelled" ? "○" : "✖"}</span>
        ${details.description === undefined ? html`<code class="background-bash-command" title=${details.command}>${details.command}</code>`
          : html`<span class="background-bash-command" title=${details.command}>${details.description}</span>`}
        <bash-log-button .logPath=${details.logPath} .machineId=${context.machineId}></bash-log-button>
      </summary>
      ${details.description === undefined ? null : html`<code class="background-bash-full-command">${details.command}</code>`}
      <pre class="background-bash-output">${part.output}</pre>
      <div class="background-bash-log"><code>${details.logPath}</code>
        <button type="button" class="ui-button ui-button--compact" aria-label="Copy log path" @click=${() => { void writeClipboardText(details.logPath); }}>Copy</button>
      </div>
    </details>
  `;
}

function formatToolCallArguments(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    const formatted: unknown = JSON.stringify(args, undefined, 2);
    return typeof formatted === "string" ? formatted : String(args);
  } catch {
    return String(args);
  }
}
