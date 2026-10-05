# Session catalog hot paths: RT-005 and RT-007 results

These measurements cover the session summary scanner and the gateway's id lookups (`/sessions/recent` and `/sessions/locate`).
Baseline: `79fd0483`. Candidate: the commit that adds this file.

## What changed

- **RT-005 prune.** The scanner memo is now grouped by directory, so pruning touches only the scanned directory's entries.
  The old prune ran a whole-memo `startsWith` walk once per directory, about 7.8k × 113 checks per global listing.
  It also no longer drops the memo of a session directory nested below the scanned one.
- **Global cold-scan bound.** Whole-file reads are capped at 32 per scanner across every directory, with read buffers reused.
  The old cap was 10 workers per directory, which meant up to 1,130 × 4 MiB buffers during a cold global listing.
  Buffers are released once the scanner goes idle.
- **Concurrent duplicate listings.** A request that arrives while a scan of the same directory is running joins the one scan queued behind it.
  It never joins the running scan, so no caller gets a result that started before its request, and completed results are not cached.
- **Invalidation race.** A read that is still in flight during `invalidate`/`clear` answers its own listing but is not memoized.
- **RT-007 locate/resolve.** Header reads run with bounded concurrency: 16 per lookup.
  The winner is still chosen in the old order: filename bucket first, then remaining files, newest embedded timestamp first, ties broken by plain path order.
  An exact header id beats a prefix match wherever it appears.
  An exact hit stops claiming later candidates.
  Concurrent lookups share in-flight header reads only, so no header or miss is remembered.

`SessionDirResolver` and its synchronous settings lock are unchanged.

## Scale and method

- **Input:** a private APFS clone of the live default session store, read-only: 113 dirs, 7,854 `.jsonl`, 3,792 MB.
  The same copy served every before and after run.
- **Runs:** each run is a fresh Node process, with the OS page cache warm.
  Base and candidate runs were interleaved, 3 rounds.
- **Load:** the host was heavily contended, with a load average of 32–100 on 14 cores.
  Wall times are noisy, so CPU time is the steadier signal.
- **Parity:** result digests (sha256 of the full JSON result) were identical for base and candidate in every run.
  - recent: `f972a59c…`; 4-concurrent recent: `23d1abb9…`
  - hit: `13a2c4ae…`; 8 hits: `638418636…`; prefix: `766b7fe1…`

Command, run from each source root (`$SRC` is the baseline export or this worktree; `$AGENT_COPY/sessions` is the copied store):

```sh
node --import tsx bench.mts "$SRC" "$AGENT_COPY" recent
node --import tsx bench.mts "$SRC" "$AGENT_COPY" locate
```

## Results (median of 3 interleaved rounds; ranges in brackets)

| Path | Base | Candidate | Gain |
| --- | --- | --- | --- |
| recent warm p50 wall | 711 ms [651–1802] | 172 ms [148–220] | 4.1× |
| recent warm p95 wall | 956 ms [764–2120] | 378 ms [249–453] | 2.5× |
| recent warm CPU p50 | 542 ms [538–553] | 219 ms [214–226] | 2.5× |
| recent warm event-loop max | 655 ms [543–1468] | 80 ms [53–107] | 8× |
| recent 4 concurrent (500/300/500/300) | 2,401 ms [1974–8074], loop max 1,736 | 336 ms [285–431], loop max 25 | 7× |
| recent cold wall | 5,350 ms [3612–11499] | 5,361 ms [3895–6436] | parity |
| recent cold CPU | 4,408 ms | 4,439 ms | parity |
| recent cold peak RSS | 808 MB [612–873] | 451 MB [429–461] | −44% |
| recent cold peak arrayBuffers | 1,892 MB | 176 MB | −91% |
| locate hit | 58 ms | 35 ms | 1.7× |
| locate miss | 3,630 ms [2635–11176] | 590 ms [346–626] | 6× |
| locate miss, CPU | 1,779 ms | 955 ms | 1.9× |
| 8 concurrent distinct misses | 7,529 ms [5554–10895], CPU 5.6 s | 1,092 ms [567–1167], CPU 1.3 s | 6.9× |
| 8 concurrent identical misses | 5,418 ms | 827 ms | 6.5× |
| 8 concurrent distinct hits | 335 ms | 197 ms | 1.7× |
| 8-character prefix lookup | 2,114 ms | 551 ms | 3.8× |

Two follow-up warm runs on the final code, at load average 57–100, showed the same picture:

- warm CPU p50: 504–564 ms (base) against 214–218 ms (candidate);
- event-loop max: 1.0–1.9 s against 148–237 ms;
- 4 concurrent listings: 2.8–6.8 s against 0.65–0.8 s.

Choosing the global read bound used simultaneous paired cold runs, where base and the variant ran at the same moment:

- 10 reads: 2–14% slower wall than base;
- 32 reads: 3–5% slower wall than base, with lower CPU;
- the interleaved medians above show parity at 32.

## Limits

- Measurements come from a single host under heavy unrelated load, so absolute wall times are not representative. Ratios and CPU are steadier.
- The cold path is still dominated by parse CPU (~4.4 s). A persisted memo would remove that; it is out of scope.
- Locate misses still read every header. The next step is to consult the scanner memo with stat validation, which is not done here.
- A batch locate endpoint would need a client change.
- In-flight header sharing can hand a lookup a read that started at most one header read before its request.
  Headers are written when a session is created, so only a session whose file appears inside that window could be missed, and the next lookup finds it.

## Benchmark script (`bench.mts`)

```ts
// Usage: node --import tsx bench.mts <src-root> <agentDir> <recent|cold|locate>
// Prints aggregates and digests only (no ids, paths, titles).
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [srcRoot, agentDir, mode] = process.argv.slice(2);
const mod = await import(pathToFileURL(join(srcRoot, "src/server/sessions/piSessionManagerGateway.ts")).href);
const gw = mod.createPiSessionManagerGateway({ agentDir, env: { HOME: join(agentDir, "..") } });

let peakRss = 0, peakAb = 0;
const sampler = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakAb = Math.max(peakAb, m.arrayBuffers); }, 5);
const mb = (n: number) => (n / 1048576).toFixed(0);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
async function timed<T>(fn: () => Promise<T>) {
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  const c = process.cpuUsage(); const t = performance.now(); const r = await fn(); const ms = performance.now() - t; const cu = process.cpuUsage(c);
  h.disable(); return { r, ms, eldMax: h.max / 1e6, cpu: (cu.user + cu.system) / 1000 };
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

const root = join(agentDir, "sessions");
const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
const files = (await Promise.all(dirs.map(async (d) => (await readdir(d)).filter((n) => n.endsWith(".jsonl")).map((n) => join(d, n))))).flat();
let bytes = 0; for (const f of files) bytes += (await stat(f)).size;
console.log(`scale dirs=${dirs.length} files=${files.length} MB=${mb(bytes)}`);

if (mode === "recent" || mode === "cold") {
  const cold = await timed(() => gw.listRecent(1e9));
  console.log(`recent cold ms=${cold.ms.toFixed(0)} cpu=${cold.cpu.toFixed(0)} eldMax=${cold.eldMax.toFixed(0)} n=${cold.r.length} peakRssMB=${mb(peakRss)} peakArrayBuffersMB=${mb(peakAb)} digest=${digest(cold.r)}`);
  if (mode === "cold") process.exit(0);
  const warm: number[] = [], eld: number[] = [], cpu: number[] = []; let d = "";
  for (let i = 0; i < 8; i += 1) { const w = await timed(() => gw.listRecent(1e9)); warm.push(w.ms); eld.push(w.eldMax); cpu.push(w.cpu); d = digest(w.r); }
  console.log(`recent warm8 p50=${pct(warm, 0.5).toFixed(0)} p95=${pct(warm, 0.95).toFixed(0)} cpuP50=${pct(cpu, 0.5).toFixed(0)} eldMax=${Math.max(...eld).toFixed(0)} digest=${d}`);
  const c4 = await timed(() => Promise.all([500, 300, 500, 300].map((n) => gw.listRecent(n))));
  console.log(`recent warm 4-concurrent ms=${c4.ms.toFixed(0)} cpu=${c4.cpu.toFixed(0)} eldMax=${c4.eldMax.toFixed(0)} digest=${digest(c4.r)}`);
} else {
  const names = files.map((f) => f.slice(f.lastIndexOf("/") + 1)).sort();
  const idOf = (n: string) => n.slice(n.indexOf("_") + 1, -6);
  const hitIds = [0.1, 0.3, 0.5, 0.7, 0.9, 0.2, 0.4, 0.6].map((q) => idOf(names[Math.floor(q * names.length)]));
  const miss = (i: number) => `00000000-0000-7000-8000-00000000000${i}`;
  const hit = await timed(() => gw.locate(hitIds[0]));
  console.log(`locate hit ms=${hit.ms.toFixed(0)} cpu=${hit.cpu.toFixed(0)} eldMax=${hit.eldMax.toFixed(0)} found=${hit.r !== undefined} digest=${digest(hit.r)}`);
  const m1 = await timed(() => gw.locate(miss(0)));
  console.log(`locate miss ms=${m1.ms.toFixed(0)} cpu=${m1.cpu.toFixed(0)} eldMax=${m1.eldMax.toFixed(0)} found=${m1.r !== undefined}`);
  const m2 = await timed(() => gw.locate(miss(0)));
  console.log(`locate miss(2nd) ms=${m2.ms.toFixed(0)} cpu=${m2.cpu.toFixed(0)} eldMax=${m2.eldMax.toFixed(0)}`);
  const m8 = await timed(() => Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => gw.locate(miss(i)))));
  console.log(`locate 8-concurrent distinct misses ms=${m8.ms.toFixed(0)} cpu=${m8.cpu.toFixed(0)} eldMax=${m8.eldMax.toFixed(0)} found=${m8.r.filter(Boolean).length}`);
  const s8 = await timed(() => Promise.all([0, 0, 0, 0, 0, 0, 0, 0].map(() => gw.locate(miss(0)))));
  console.log(`locate 8-concurrent same miss ms=${s8.ms.toFixed(0)} cpu=${s8.cpu.toFixed(0)} eldMax=${s8.eldMax.toFixed(0)}`);
  const h8 = await timed(() => Promise.all(hitIds.map((id) => gw.locate(id))));
  console.log(`locate 8-concurrent distinct hits ms=${h8.ms.toFixed(0)} cpu=${h8.cpu.toFixed(0)} eldMax=${h8.eldMax.toFixed(0)} found=${h8.r.filter(Boolean).length} digest=${digest(h8.r)}`);
  const p = await timed(() => gw.locate(hitIds[1].slice(0, 8)));
  console.log(`locate 8-char prefix ms=${p.ms.toFixed(0)} cpu=${p.cpu.toFixed(0)} found=${p.r !== undefined} digest=${digest(p.r)}`);
  console.log(`peakRssMB=${mb(peakRss)} peakArrayBuffersMB=${mb(peakAb)}`);
}
clearInterval(sampler);
```
