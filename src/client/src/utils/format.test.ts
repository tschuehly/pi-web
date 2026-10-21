import { describe, expect, it } from "vitest";
import { formatAge, formatElapsed, formatFileSize } from "./format";

describe("formatFileSize", () => {
  it("keeps small sizes in whole bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("scales to binary units with one decimal below ten and whole numbers above", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 12)).toBe("12 KB");
    expect(formatFileSize(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatFileSize(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
  });

  it("falls back to zero for unusable sizes", () => {
    expect(formatFileSize(-1)).toBe("0 B");
    expect(formatFileSize(Number.NaN)).toBe("0 B");
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("formatElapsed and formatAge", () => {
  it("use the coarsest unit that still reads precisely", () => {
    expect([0, 45_000, 12 * 60_000 + 59_000, 65 * 60_000, 50 * 3_600_000].map(formatElapsed)).toEqual(["0s", "45s", "12m", "1h 05m", "2d 2h"]);
    expect([-5_000, 9_000, 45_000, 12 * 60_000, 3 * 3_600_000, 49 * 3_600_000].map(formatAge)).toEqual(["just now", "just now", "45s ago", "12m ago", "3h ago", "2d ago"]);
  });
});
