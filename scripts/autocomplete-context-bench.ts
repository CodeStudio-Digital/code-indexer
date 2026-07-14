/** Opt-in local FTS benchmark. Emits paths/metrics only; never copies project code. */
import { CodeIndexDB } from '../packages/store/src/db.js';
import { loadConfig } from '../packages/shared/src/utils/config.js';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const projectId = Number(arg('--project-id'));
const ids = (arg('--identifiers') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!Number.isFinite(projectId) || projectId <= 0 || !ids.length) {
  throw new Error('Usage: tsx scripts/autocomplete-context-bench.ts --project-id <id> --identifiers id1,id2 [--expect-path suffix]');
}
const cfg = loadConfig();
const db = new CodeIndexDB(cfg.dbPath);
try {
  const started = performance.now();
  const query = ids.slice(0, 5).map((id) => `"${id.replace(/"/g, '""')}"`).join(' OR ');
  const matches = db.searchFileContents(projectId, query, 12);
  const elapsedMs = performance.now() - started;
  const expected = arg('--expect-path')?.replace(/\\/g, '/');
  console.log(JSON.stringify({
    projectId, identifiers: ids, elapsedMs: Math.round(elapsedMs * 10) / 10,
    matches: matches.map((m) => ({ path: m.path, rank: m.rank })),
    expectedRecovered: expected ? matches.some((m) => m.path.replace(/\\/g, '/').endsWith(expected)) : null,
  }, null, 2));
} finally { db.close(); }
