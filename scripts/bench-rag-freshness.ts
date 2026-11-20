/** Measure physical writes through the real watcher, durable queue, parser, index publication and symbol query. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProjectIndexService, createInProcessStructuralExecutor, readProjectIndexSettings } from '@mcp/services/services/project-index/index.js';

const size = Number(process.argv[2] ?? 10000), samples = Number(process.argv[3] ?? 200);
if (![1000,10000,50000,150000].includes(size) || !Number.isInteger(samples) || samples < 1 || samples > 2000) throw new Error('Invalid fixture size or sample count');
const out = resolve('.tmp/agent-ide-reliability','freshness-' + size + '-' + Date.now());
const root = join(out,'project'), observed = 'Receipt.ts', abs = join(root,observed);
mkdirSync(root,{recursive:true});
process.env.MCP_DATA_DIR = join(out,'profile');
mkdirSync(process.env.MCP_DATA_DIR,{recursive:true});
execFileSync('git',['init','-q'],{cwd:root,windowsHide:true});
const data = (i: number) => 'export function receiptVersion' + i + '() { return ' + i + '; }\n';
writeFileSync(abs,data(0));
for (let i = 1; i < size; i++) {
  const dir = join(root,'group' + Math.floor((i-1)/250));
  if ((i-1)%250 === 0) mkdirSync(dir);
  writeFileSync(join(dir,'Record' + i + '.ts'),'export const record' + i + ' = ' + i + ';\n');
}
const db = new CodeIndexDB(join(out,'main.db'));
const cfg = readProjectIndexSettings();
// The product defaults to polling above the live watch budget. A live experiment is opt-in.
if (process.argv.includes('--live')) cfg.watchMaxFiles = size + Math.ceil(size / 250) + 2000;
const svc = new ProjectIndexService(db,createInProcessStructuralExecutor(db),undefined,()=>cfg);
const project = db.createProject('freshness-' + size,root);
svc.setOpenPathsProvider(() => [observed]);
try {
  const start = performance.now();
  svc.activate(project.id,'benchmark');
  const ready = await svc.ensureStructuralReady(project.id, 900000);
  assert.equal(ready.status,'ready',JSON.stringify(ready));
  assert.equal(db.listFiles(project.id).length,size);
  if (process.argv.includes('--live')) assert.equal(svc.getStatus(project.id).watcherMode, 'live');
  const coldMs = performance.now()-start;
  const measured: number[] = [];
  for (let i = 1; i <= 10 + samples; i++) {
    const token = 'receiptVersion' + i, begin = performance.now();
    writeFileSync(abs,data(i));
    for (;;) {
      const hits = db.searchSymbols(project.id,token,3);
      if (hits.some(s => s.name === token && s.file_path === observed)) break;
      if (performance.now()-begin > 15000) throw new Error('Watcher failed to publish ' + token + ': ' + JSON.stringify(svc.getStatus(project.id)));
      await wait(20);
    }
    assert.ok(!db.getSymbolsByFile(project.id,observed).some(s => s.name === 'receiptVersion' + (i-1)));
    const ms = performance.now()-begin;
    if (i > 10) measured.push(ms);
    appendFileSync(join(out,'samples.jsonl'),JSON.stringify({i,ms})+'\n');
    if (i % 50 === 0) console.log(size,i,ms);
  }
  measured.sort((a,b)=>a-b);
  const p = (q: number) => measured[Math.ceil(measured.length*q)-1];
  const report = { out,size,samples,warmups:10,coldMs,status:svc.getStatus(project.id),liveBudget:cfg.watchMaxFiles,
    debounceMs:cfg.watchDebounceMs,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),maxMs:p(1) };
  writeFileSync(join(out,'summary.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally { await svc.dispose(); db.close(); }
