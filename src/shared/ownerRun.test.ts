import { describe, expect, it } from "vitest";
import { ownerRunProposal, ownerRunProposals } from "./ownerRun";

describe("ownerRunProposals", () => {
  it("finds closed top-level pi-run blocks with their mode, folder and literal command", () => {
    const text = 'Run this:\n\n```pi-run cwd="/Users/me/repo"\npwd; exit 7\n```\n\nAnd this one needs your password:\n\n```pi-run terminal cwd="/tmp/a b"\nsudo darwin-rebuild switch\n```\n';
    expect(ownerRunProposals(text)).toEqual([
      { mode: "run", cwd: "/Users/me/repo", command: "pwd; exit 7" },
      { mode: "terminal", cwd: "/tmp/a b", command: "sudo darwin-rebuild switch" },
    ]);
  });

  it("leaves quoted, listed, unclosed, plain and malformed blocks inert", () => {
    const text = [
      '> ```pi-run cwd="/q"\n> echo quoted\n> ```',
      '- item\n\n  ```pi-run cwd="/l"\n  echo listed\n  ```',
      '```sh\necho plain\n```',
      '```pi-run cwd=/no-quotes\necho bad\n```',
      '```pi-run cwd="relative"\necho bad\n```',
      '```pi-run sudo cwd="/x"\necho unknown option\n```',
      '```pi-run cwd="/x"\n\n```',
      '```pi-run cwd="/x"\necho streaming',
    ].join("\n\n");
    expect(ownerRunProposals(text)).toEqual([]);
  });

  it("refuses control and bidi characters and oversized commands", () => {
    expect(ownerRunProposal('pi-run cwd="/x"', "echo \u202eevil")).toHaveProperty("error");
    expect(ownerRunProposal('pi-run cwd="/x"', "echo \u0007")).toHaveProperty("error");
    expect(ownerRunProposal('pi-run cwd="/x\u0000"', "echo")).toHaveProperty("error");
    expect(ownerRunProposal('pi-run cwd="/x\\"y"', "echo")).toHaveProperty("error");
    expect(ownerRunProposal('pi-run cwd="/x"', "x".repeat(8 * 1024 + 1))).toHaveProperty("error");
    expect(ownerRunProposal('pi-run cwd="/x"', "echo a\n\techo b")).toEqual({ mode: "run", cwd: "/x", command: "echo a\n\techo b" });
  });
});
