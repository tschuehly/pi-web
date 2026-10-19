// @vitest-environment happy-dom
import { expect, it } from "vitest";

it("answers no focused element for a shadow root while focus sits in another one", () => {
  const [mine, other] = [document.createElement("div"), document.createElement("div")];
  const input = document.createElement("input");
  other.attachShadow({ mode: "open" }).append(input);
  const root = mine.attachShadow({ mode: "open" });
  document.body.append(mine, other);
  input.focus();
  expect(root.activeElement).toBeNull();
  expect(other.shadowRoot?.activeElement).toBe(input);
  document.body.replaceChildren();
});
