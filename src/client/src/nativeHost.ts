export interface PiWebNativeHost {
  pickDirectory(): Promise<string | null>;
  requestNotificationPermission?: () => Promise<void>;
  notify?: (title: string, body: string, target: { machineId: string; sessionId: string; message?: string }) => Promise<void>;
  getSleepDisabled?: () => Promise<boolean>;
  setSleepDisabled?: (disabled: boolean) => Promise<boolean>;
  /** macOS app only: opens an existing local HTML file in the default browser. */
  openLocalFile?: (path: string) => Promise<boolean>;
  /** macOS app only: selects an existing local file or folder in Finder. */
  revealLocalFile?: (path: string) => Promise<boolean>;
}

declare global {
  interface Window {
    piWebNative?: PiWebNativeHost;
  }
}

export function nativeDirectoryPicker(machineId: string): PiWebNativeHost | undefined {
  if (machineId !== "local") return undefined;
  return window.piWebNative;
}
