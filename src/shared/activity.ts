import type { SessionActivity, SessionStatus } from "./apiTypes.js";

/**
 * Whether a session has work in progress a user could stop or must wait for.
 *
 * A startup activity is excluded: the session is being opened, not worked in.
 * The exclusion can only ever remove the activity-phase reason for being
 * active, so streaming, bash, compaction, and queued prompts still count even
 * while a startup report is the latest activity.
 */
export function isSessionActive(status?: SessionStatus, activity?: SessionActivity): boolean {
  return (activity?.phase === "active" && activity.startup !== true)
    || status?.isStreaming === true
    || status?.isBashRunning === true
    || status?.isCompacting === true
    || (status?.pendingMessageCount ?? 0) > 0;
}

/** What a live session is doing, for compact re-entry rows outside the Chat itself. */
export function sessionActivityText(activity?: SessionActivity): string | undefined {
  if (activity === undefined) return undefined;
  return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
}
