import type { WindowLocks } from "./workbenchWindowController";

/** Web Locks shared by one test's windows: exclusive and first-come per name; `ifAvailable` never waits. */
export class FakeLocks implements WindowLocks {
  private readonly queues = new Map<string, (() => void)[]>();

  async request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: Lock | null) => T): Promise<Awaited<T>> {
    const queue = this.queues.get(name);
    if (queue === undefined) this.queues.set(name, []);
    else if (options.ifAvailable === true) return await callback(null);
    else await new Promise<void>((granted) => { queue.push(granted); });
    try {
      return await callback({ name, mode: "exclusive" });
    } finally {
      const next = this.queues.get(name)?.shift();
      if (next === undefined) this.queues.delete(name);
      else next();
    }
  }

  query(): Promise<LockManagerSnapshot> {
    return Promise.resolve({ held: [...this.queues.keys()].map((name) => ({ name, mode: "exclusive" })) });
  }

  /** Holds `name` as another page would, until the returned release is called. */
  hold(name: string): () => void {
    let release = (): void => undefined;
    void this.request(name, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    return () => { release(); };
  }
}
