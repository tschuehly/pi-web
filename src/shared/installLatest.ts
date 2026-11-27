/**
 * One build pair: the Pi Workbench and PI WEB revisions installed together (pi-workbench `promote-installed latest`).
 * The installed pair names a product with nothing installed yet `none`; `latest --from none none` is the first install.
 */
export interface InstallPair {
  workbench: string;
  piWeb: string;
}

export const NOT_INSTALLED = "none";
export const nothingInstalled = (pair: InstallPair): boolean => pair.workbench === NOT_INSTALLED || pair.piWeb === NOT_INSTALLED;

/** A merge on an integration branch that the latest pair has and the installed pair lacks. */
export interface InstallMerge {
  repo: "pi-workbench" | "pi-web";
  sha: string;
  subject: string;
}

/** `promote-installed latest --dry-run --json`. */
export interface InstallLatestPreview {
  installed: InstallPair;
  latest: InstallPair;
  merges: InstallMerge[];
  upToDate: boolean;
  blocked?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// A Git object name or `none`: the script passes these back as arguments, so nothing else may get through.
const REV = /^(?:[0-9a-f]{7,64}|none)$/u;

export function parseInstallPair(value: unknown): InstallPair {
  if (
    !isRecord(value)
    || typeof value["workbench"] !== "string"
    || typeof value["piWeb"] !== "string"
    || !REV.test(value["workbench"])
    || !REV.test(value["piWeb"])
  )
    throw new TypeError("Expected a {workbench, piWeb} revision pair");
  return { workbench: value["workbench"], piWeb: value["piWeb"] };
}

export function parseInstallLatestPreview(value: unknown): InstallLatestPreview {
  if (!isRecord(value) || !Array.isArray(value["merges"]) || typeof value["upToDate"] !== "boolean") throw new TypeError("Unexpected install preview");
  const merges = value["merges"].map((merge: unknown): InstallMerge => {
    if (
      !isRecord(merge)
      || (merge["repo"] !== "pi-workbench" && merge["repo"] !== "pi-web")
      || typeof merge["sha"] !== "string"
      || typeof merge["subject"] !== "string"
    ) {
      throw new TypeError("Unexpected merge in install preview");
    }
    return { repo: merge["repo"], sha: merge["sha"], subject: merge["subject"] };
  });
  if (value["blocked"] !== undefined && typeof value["blocked"] !== "string") throw new TypeError("Unexpected install preview");
  return {
    installed: parseInstallPair(value["installed"]),
    latest: parseInstallPair(value["latest"]),
    merges,
    upToDate: value["upToDate"],
    ...(value["blocked"] === undefined ? {} : { blocked: value["blocked"] }),
  };
}
