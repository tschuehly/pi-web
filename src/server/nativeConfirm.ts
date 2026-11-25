import { execFile } from "node:child_process";

/** Asks the owner at this Mac; resolves true only for Allow. */
export type NativeConfirm = (text: string) => Promise<boolean>;

/**
 * A macOS dialog with Deny and Allow (pattern of Pi Workbench `/full-access on`): a local process can send PI WEB any
 * request, but only the owner can click Allow. Deny, the 60 s give-up, a killed dialog or any error is no.
 */
export function macosConfirm(text: string, title = "PI WEB"): Promise<boolean> {
  const script = ["on run argv", `display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after 60`, "end run"];
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", [...script.flatMap((line) => ["-e", line]), text, title], { encoding: "utf8", timeout: 70_000 }, (error, stdout) => {
      resolve(error === null && stdout.includes("button returned:Allow") && !stdout.includes("gave up:true"));
    });
  });
}

/** The platform's confirmation, or undefined where PI WEB has none (not macOS). */
export const nativeConfirm = (platform: NodeJS.Platform = process.platform): NativeConfirm | undefined =>
  platform === "darwin" ? (text) => macosConfirm(text) : undefined;
