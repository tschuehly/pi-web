interface ProcessNode {
  pid: number;
  ppid: number;
}

export function leafProcessOwners<T extends ProcessNode>(
  processes: readonly T[],
  candidates: readonly T[],
): T[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const candidatePids = new Set(candidates.map((process) => process.pid));
  const ancestorCandidatePids = new Set<number>();

  for (const candidate of candidates) {
    let cursor = byPid.get(candidate.ppid);
    const seen = new Set([candidate.pid]);
    while (cursor !== undefined && !seen.has(cursor.pid)) {
      if (candidatePids.has(cursor.pid)) ancestorCandidatePids.add(cursor.pid);
      seen.add(cursor.pid);
      cursor = byPid.get(cursor.ppid);
    }
  }

  return candidates.filter((candidate) => !ancestorCandidatePids.has(candidate.pid));
}
