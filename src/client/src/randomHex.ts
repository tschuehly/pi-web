/** `bytes` random bytes as hex; getRandomValues also works on plain-http LAN origins, where randomUUID is missing. */
export function randomHex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
