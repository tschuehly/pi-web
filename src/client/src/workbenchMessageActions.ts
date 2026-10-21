import { html } from "lit";
import type { DisplayedMessageActionAvailabilityContext, MessageActionAvailabilityContext, MessageActionContribution, MessageActionResult } from "../../plugin-api";
import { isSessionActive } from "../../shared/activity";
import type { AppState } from "./appState";
import { writeClipboardText } from "./clipboard";
import { createCoreMessageActions } from "./plugins/core/messageActions";
import type { RegisteredMessageAction } from "./plugins/messageActions";
import { publicPluginSelection } from "./plugins/publicContext";

/** The Workbench shell hosts no plugins: it offers the core history and copy actions, without fork, as "Revert to here". */
export const WORKBENCH_MESSAGE_ACTIONS: readonly RegisteredMessageAction[] = createCoreMessageActions().flatMap((action): MessageActionContribution[] => {
  if (action.id === "message.fork") return [];
  if (action.id !== "message.back" || action.target === "display") return [action];
  return [
    { ...action, title: "Revert to here", ariaLabel: () => "Revert to here" },
    // Going back to a user message restores its text to the composer, ready to edit and send again.
    { ...action, id: "message.edit", title: "Edit & resend", ariaLabel: () => "Edit and resend", icon: html`<span aria-hidden="true">✎</span>`,
      visible: (context) => context.message.role === "user" && (action.visible?.(context) ?? true) },
  ];
}).map((action) => ({ ...action, binding: { registrationPluginId: "core", sourcePluginId: "core" } }));

/** Availability for the selected Chat; history actions wait while it is busy. */
export function workbenchMessageActionContext(state: AppState): Omit<MessageActionAvailabilityContext, "message"> | undefined {
  const session = publicPluginSelection(state).selectedSession;
  if (session === undefined) return undefined;
  const machine = state.selectedMachine;
  return {
    machine: machine === undefined ? { id: "local", name: "local", kind: "local" } : { id: machine.id, name: machine.name, kind: machine.kind },
    session: { ...session, busy: state.sendingPrompts[session.id] === true || isSessionActive(state.status, state.activity) },
  };
}

/** Runs an entry action on the Chat's history: Revert and Edit go back to the entry; fork is not offered. */
export async function runWorkbenchMessageAction(actOnMessage: (entryId: string, action: "fork" | "back") => Promise<void>, input: MessageActionAvailabilityContext, actionId: string): Promise<MessageActionResult> {
  if (actionId === "message.back" || actionId === "message.edit") await actOnMessage(input.message.entryId, "back");
}

export async function runWorkbenchDisplayedMessageAction(input: DisplayedMessageActionAvailabilityContext, actionId: string): Promise<MessageActionResult> {
  if (actionId !== "message.copy") return;
  if (!await writeClipboardText(input.message.text)) throw new Error("Unable to copy message to the clipboard.");
  return { title: "Copied", ariaLabel: `Copied ${input.message.role} message`, icon: html`<span aria-hidden="true">✓</span>` };
}
