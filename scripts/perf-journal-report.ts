#!/usr/bin/env tsx
/**
 * Perf journal report — aggregates the crash-resilient diagnostics written by
 * `apps/http-api/server/perf/persistent-diagnostics.ts` into a single comparable
 * summary.
 *
 * This is the ruler for the "tirar do main" waves: capture a baseline, land a
 * wave, re-run, and diff. The three numbers that matter:
 *
 *   - freezes by SOURCE — `offloop`/`handler` (main really blocked, offload
 *     fixes it) vs `starved` (loop was IDLE, clock jumped; worker_threads do
 *     NOT help — look at `rssMB` and the OS working set instead).
 *   - slow calls by CHANNEL — p95/max per IPC channel; a migrated channel
 *     should drop out of the table entirely.
 *   - `unattributedRssMB` — shrinks as subsystems register in the memory
 *     ledger. Main RSS is the target of the DB-process wave.
 *
 * Usage:
 *   npx tsx scripts/perf-journal-report.ts
 *   npx tsx scripts/perf-journal-report.ts --since 2026-07-24
 *   npx tsx scripts/perf-journal-report.ts --json > baseline.json
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mcpDataDir } from '@mcp/shared/utils/config.js';

interface Bucket { n: number; total: number; max: number; samples: number[] }
interface MainStats {
  rssMB: number; heapUsedMB: number; nativeMB: number; unattributedRssMB: number;
}
interface Sample {
  at: number;
  main: MainStats & Record<string, number>;
  processes?: Array<{ type: string; name: string; workingSetMB?: number }>;
  ledger?: Array<{ name: string; count: number; bytes?: number; detail?: string }>;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const sinceRaw = args[args.indexOf('--since') + 1];
const since = args.includes('--since') && sinceRaw ? Date.parse(sinceRaw) : 0;
const dirArg = args[args.indexOf('--dir') + 1];
const root = args.includes('--dir') && dirArg
  ? dirArg
  : join(mcpDataDir(), 'diagnostics', 'performance');

const bucket = (): Bucket => ({ n: 0, total: 0, max: 0, samples: [] });
function add(m: Map<string, Bucket>, key: string, ms: number): void {
  const b = m.get(key) ?? bucket();
  b.n++; b.total += ms; b.max = Math.max(b.max, ms); b.samples.push(ms);
  m.set(key, b);
}
function pct(b: Bucket, p: number): number {
  const s = [...b.samples].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] ?? 0);
}

const freezes = new Map<string, Bucket>();
const slow = new Map<string, Bucket>();
/**
 * `offloop` rows collapsed to one entry per real hang.
 *
 * The worker watchdog re-reports a still-ongoing stall every `repeatMs` with a
 * cumulative `durationMs`, so a single 12s hang is written as 1.6s + 6.6s +
 * 11.6s. Summing those inflates total freeze time ~2x. Rows carry a `hangId`;
 * journals written before that field existed are collapsed by their derived
 * start instant (`at - durationMs`), which is constant across re-reports.
 */
const hangs = new Map<string, { key: string; max: number }>();
const procPeak = new Map<string, number>();
const runSpans = new Map<string, { min: number; max: number }>();
let peak: Sample | null = null;
let runs = 0;
let freezeRss = 0;
let freezeRssN = 0;

let dirs: string[];
try {
  dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
} catch {
  console.error(`No perf journals at ${root}. Run the app once, then retry.`);
  process.exit(1);
}

for (const d of dirs) {
  const dp = join(root, d);
  let counted = false;
  for (const f of readdirSync(dp)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dp, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const at = Number(o.at ?? 0);
      if (since && at < since) continue;
      if (!counted) { runs++; counted = true; }

      if (o.type === 'slow_call') {
        add(slow, String(o.channel ?? '?'), Number(o.durationMs ?? 0));
      } else if (o.type === 'freeze') {
        const e = (o.event ?? o) as Record<string, unknown>;
        const src = String(e.source ?? '?');
        const ms = Number(e.durationMs ?? 0);
        const key = `${src}${e.channel ? ` / ${String(e.channel)}` : ''}`;
        if (src === 'offloop') {
          const id = typeof e.hangId === 'string' && e.hangId
            ? e.hangId
            : `${key}@${Math.round((Number(e.at ?? at) - ms) / 1000)}`;
          const prev = hangs.get(id);
          if (!prev || ms > prev.max) hangs.set(id, { key, max: ms });
        } else {
          add(freezes, key, ms);
        }
        if (typeof e.rssMB === 'number') { freezeRss += e.rssMB; freezeRssN++; }
      } else if (o.type === 'sample') {
        const s = o.sample as Sample;
        if (!peak || s.main.rssMB > peak.main.rssMB) peak = s;
        for (const p of s.processes ?? []) {
          const k = `${p.type}:${p.name}`;
          procPeak.set(k, Math.max(procPeak.get(k) ?? 0, p.workingSetMB ?? 0));
        }
        const rs = runSpans.get(d) ?? { min: Infinity, max: 0 };
        runSpans.set(d, { min: Math.min(rs.min, s.at), max: Math.max(rs.max, s.at) });
      }
    }
  }
}

// Fold the collapsed hangs in now that every re-report has been seen.
for (const h of hangs.values()) add(freezes, h.key, h.max);

let hours = 0;
for (const v of runSpans.values()) if (v.max > v.min) hours += (v.max - v.min) / 3_600_000;

if (asJson) {
  const dump = (m: Map<string, Bucket>): Record<string, unknown> =>
    Object.fromEntries([...m].map(([k, b]) => [k, {
      n: b.n, totalMs: Math.round(b.total), maxMs: Math.round(b.max),
      p50: pct(b, 50), p95: pct(b, 95),
    }]));
  console.log(JSON.stringify({
    root, runs, observedHours: Number(hours.toFixed(2)),
    freezes: dump(freezes), slowCalls: dump(slow),
    peakMain: peak?.main ?? null, peakLedger: peak?.ledger ?? null,
    processPeakMB: Object.fromEntries(procPeak),
  }, null, 2));
  process.exit(0);
}

const pad = (v: string | number, n: number): string => String(v).padStart(n);
const table = (m: Map<string, Bucket>, title: string, withPct: boolean): void => {
  console.log(`\n=== ${title} ===`);
  if (m.size === 0) { console.log('  (nenhum)'); return; }
  for (const [k, b] of [...m].sort((a, z) => z[1].total - a[1].total).slice(0, 25)) {
    const extra = withPct ? `  p50=${pad(pct(b, 50), 5)}ms  p95=${pad(pct(b, 95), 6)}ms` : '';
    console.log(
      `  ${pad(b.n, 4)}x  tot=${pad(Math.round(b.total), 7)}ms  max=${pad(Math.round(b.max), 6)}ms` +
      `  avg=${pad(Math.round(b.total / b.n), 5)}ms${extra}  ${k}`,
    );
  }
};

const freezeTotal = [...freezes.values()].reduce((a, b) => a + b.total, 0);
const starved = [...freezes].filter(([k]) => k.startsWith('starved'))
  .reduce((a, [, b]) => a + b.total, 0);

console.log(`Perf journal: ${root}`);
console.log(`${runs} runs · ${hours.toFixed(1)} h observadas · ${[...freezes.values()].reduce((a, b) => a + b.n, 0)} freezes · ${[...slow.values()].reduce((a, b) => a + b.n, 0)} slow calls`);
console.log(`Tempo total de freeze: ${(freezeTotal / 1000).toFixed(0)}s — dos quais ${(starved / 1000).toFixed(0)}s (${Math.round((starved / Math.max(1, freezeTotal)) * 100)}%) sao 'starved' (loop OCIOSO: offload nao resolve)`);
if (freezeRssN) console.log(`RSS medio no momento do freeze: ${Math.round(freezeRss / freezeRssN)} MB`);

table(freezes, 'FREEZES por source/canal', false);
table(slow, 'SLOW CALLS por canal', true);

if (peak) {
  const m = peak.main;
  console.log('\n=== PICO de memoria do main ===');
  console.log(`  rss=${m.rssMB}MB  heapUsed=${m.heapUsedMB}MB  native=${m.nativeMB}MB  NAO-ATRIBUIDO=${m.unattributedRssMB}MB`);
  console.log('  ledger no pico:');
  for (const e of (peak.ledger ?? []).filter((x) => x.count > 0 || x.bytes)) {
    const mb = e.bytes ? ` ~${Math.round(e.bytes / 1024 / 1024)}MB` : '';
    console.log(`    ${e.name}: ${e.count}${mb}${e.detail ? ` — ${e.detail}` : ''}`);
  }
  console.log('\n=== PICO por processo Electron (working set) ===');
  for (const [k, v] of [...procPeak].sort((a, z) => z[1] - a[1]).slice(0, 8)) {
    console.log(`  ${pad(Math.round(v), 5)}MB  ${k}`);
  }
}
