// happy-dom's ShadowRoot.activeElement throws instead of answering null while focus sits in a shadow root outside this
// one. CodeMirror reads it from a timer, so the throw surfaced as an unhandled error after whichever test was running.
const shadowRoot: unknown = Reflect.get(globalThis, "ShadowRoot");
const prototype: unknown = typeof shadowRoot === "function" ? shadowRoot.prototype : undefined;
const descriptor = prototype instanceof Object ? Object.getOwnPropertyDescriptor(prototype, "activeElement") : undefined;
if (prototype instanceof Object && descriptor?.get !== undefined) {
  Object.defineProperty(prototype, "activeElement", {
    configurable: true,
    get(this: ShadowRoot): Element | null {
      try {
        const active: unknown = descriptor.get?.call(this);
        return active instanceof Element ? active : null;
      } catch {
        return null;
      }
    },
  });
}
