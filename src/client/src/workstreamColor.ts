import type { ReactiveController, ReactiveControllerHost } from "lit";

export const WORKSTREAM_TINT_PERCENTAGES = {
  mark: 30,
  tab: 12,
  tabSelected: 26,
} as const;

/** A compact title-derived identity cue that remains distinct without colour. */
export function workstreamMonogram(title: string): string {
  const words = title.trim().split(/\s+/u).filter((word) => word !== "");
  if (words.length === 0) return "WS";
  const letters = words.length === 1
    ? Array.from(words[0] ?? "").slice(0, 2)
    : [Array.from(words[0] ?? "")[0], Array.from(words.at(-1) ?? "")[0]];
  return letters.filter((letter): letter is string => letter !== undefined).join("").toUpperCase();
}

/**
 * Ten accent colours as [light theme, dark theme] pairs, from Okabe-Ito with extras. The first six stay apart
 * under protan, deutan and tritan simulation; light variants are darkened for light surfaces.
 */
export const WORKSTREAM_PALETTE = [
  ["#0072B2", "#5AA9E6"], // blue
  ["#B86E00", "#E69F00"], // orange
  ["#00875F", "#2BC48F"], // bluish green
  ["#B5508E", "#E08DBF"], // reddish purple
  ["#3A9AD9", "#9ED8F7"], // sky blue
  ["#A83E00", "#F07A3A"], // vermillion
  ["#A89600", "#F0E442"], // yellow
  ["#6A4C9C", "#A98BD6"], // violet
  ["#7A4A2E", "#C4937F"], // brown
  ["#5C5C5C", "#B8B8B8"], // grey
] as const;

const ORDER_KEY = "pi-web.workstream-color-order";
const orderChanged = new EventTarget();
let openOrder: readonly string[] = readStoredOrder();

function readStoredOrder(): readonly string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

/**
 * Record the open Workstreams so they take palette entries oldest first. The last order is kept in localStorage so a
 * reload into a Workstream window does not flash fallback colours before the list loads again.
 * ponytail: one order for the whole client; per-machine orders if multi-machine Workstream lists ever disagree.
 */
export function setWorkstreamColorOrder(workstreams: readonly { id: string; createdAt: string }[]): void {
  const next = [...workstreams].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((item) => item.id);
  if (next.length === openOrder.length && next.every((id, index) => id === openOrder[index])) return;
  openOrder = next;
  try { if (typeof localStorage !== "undefined") localStorage.setItem(ORDER_KEY, JSON.stringify(next)); } catch { /* Storage is a reload nicety. */ }
  orderChanged.dispatchEvent(new Event("change"));
}

/** Re-renders its host when the Workstream colour order changes. */
export class WorkstreamColorController implements ReactiveController {
  private readonly update = (): void => { this.host.requestUpdate(); };
  constructor(private readonly host: ReactiveControllerHost) { host.addController(this); }
  hostConnected(): void { orderChanged.addEventListener("change", this.update); }
  hostDisconnected(): void { orderChanged.removeEventListener("change", this.update); }
}

/** Palette index: creation order among open Workstreams, else a stable id hash so nothing renders colourless. */
export function workstreamPaletteIndex(workstreamId: string): number {
  const position = openOrder.indexOf(workstreamId);
  if (position >= 0) return position % WORKSTREAM_PALETTE.length;
  let hash = 0;
  for (let index = 0; index < workstreamId.length; index += 1) {
    hash = (hash * 31 + workstreamId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % WORKSTREAM_PALETTE.length;
}

export function workstreamAccentColor(workstreamId: string): string {
  const [light, dark] = WORKSTREAM_PALETTE[workstreamPaletteIndex(workstreamId)] ?? WORKSTREAM_PALETTE[0];
  return `light-dark(${light}, ${dark})`;
}
