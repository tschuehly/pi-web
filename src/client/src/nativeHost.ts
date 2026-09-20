export interface PiWebNativeHost {
  pickDirectory(): Promise<string | null>;
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
