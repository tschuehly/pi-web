import { beforeEach } from "vitest";

// Node's `--localstorage-file` backs one storage file for the whole Vitest run, so
// parallel workers otherwise share localStorage and a `clear()` in one test file
// wipes state a concurrently running file just wrote. Give each worker process its
// own in-memory Storage instead; tests never need cross-file persistence.
class MemoryStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number { return this.entries.size; }
  key(index: number): string | null { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string): void { this.entries.set(key, value); }
  removeItem(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}

function installStorage(name: "localStorage" | "sessionStorage"): void {
  Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true, writable: true });
}

installStorage("localStorage");
installStorage("sessionStorage");

beforeEach(() => {
  installStorage("localStorage");
  installStorage("sessionStorage");
});
