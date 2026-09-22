export interface PiWebNativeHost {
  pickDirectory(): Promise<string | null>;
  requestNotificationPermission?: () => Promise<void>;
  notify?: (title: string, body: string) => Promise<void>;
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
