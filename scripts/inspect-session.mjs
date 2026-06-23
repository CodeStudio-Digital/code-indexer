#!/usr/bin/env node
// Read-only forensic dump for a coder_session — diagnoses tool-loop patterns
// and which guard (strict, fuzzy, dominance, dup-call-cap) SHOULD have caught
// the loop but didn't. Usage: node scripts/inspect-session.mjs <session_id>

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const sessionId = parseInt(process.argv[2], 10);
if (!Number.isFinite(sessionId) || sessionId <= 0) {
  console.error('Usage: node scripts/inspect-session.mjs <session_id>');
  process.exit(1);
}

const dbPath = process.env.MCP_DB_PATH
  ?? resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.mcp-code-indexer/index.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const DOOM_STRICT = 3;
const DOOM_FUZZY = 6;
const DOMINANCE_WINDOW = 6;
const DOMINANCE_RATIO = 0.8;
const DUP_CALL_THRESHOLD = 5;
const DUP_CALL_WINDOW = 20;
const POLLING = /(?:^|__)(?:wait_for|await|poll|tail|monitor|list)_|_(?:status|logs|pulse|stats)$/;

const sha = (s) => createHash('sha1').update(s ?? '').digest('hex').slice(0, 12);

const session = db.prepare('SELECT * FROM coder_sessions WHERE id = ?').get(sessionId);
if (!session) { console.error(`Session ${sessionId} not found`); process.exit(1); }

const calls = db.prepare(`
  SELECT tc.tool_name, tc.args_json, tc.result_text, tc.is_error, tc.duration_ms, tc.message_id
  FROM coder_tool_calls tc
  JOIN coder_messages m ON m.id = tc.message_id
  WHERE m.session_id = ? ORDER BY tc.message_id, tc.id
`).all(sessionId);

const messages = db.prepare(
  'SELECT id, role, content_json FROM coder_messages WHERE session_id = ? ORDER BY id'
).all(sessionId);

const turnHasText = new Map();
for (const m of messages) {
  if (m.role !== 'assistant') continue;
  try {
    const c = JSON.parse(m.content_json);
    turnHasText.set(m.id, Array.isArray(c) && c.some((b) => b.type === 'text' && b.text?.trim()));
  } catch { turnHasText.set(m.id, false); }
}

const turns = [];
let last = null;
for (const c of calls) {
  if (c.message_id !== last) { turns.push({ msgId: c.message_id, calls: [] }); last = c.message_id; }
  turns[turns.length - 1].calls.push({
    name: c.tool_name, argsHash: sha(c.args_json),
    resultHash: c.result_text ? sha(c.result_text) : null,
    isError: !!c.is_error, resultLen: (c.result_text ?? '').length,
  });
}

const total = calls.length;
const nameCount = new Map();
const argCount = new Map();
const resCount = new Map();
for (const c of calls) {
  nameCount.set(c.tool_name, (nameCount.get(c.tool_name) ?? 0) + 1);
  const ak = `${c.tool_name}|${sha(c.args_json)}`;
  argCount.set(ak, (argCount.get(ak) ?? 0) + 1);
  if (c.result_text) {
    const rk = `${c.tool_name}|${sha(c.result_text)}`;
    resCount.set(rk, (resCount.get(rk) ?? 0) + 1);
  }
}

const tools = [...nameCount.entries()].sort((a, b) => b[1] - a[1]);
const dom = tools[0];
const domRatio = dom ? dom[1] / total : 0;

function strictRun() {
  let max = 0, run = 0, last = '';
  for (const t of turns) {
    const sig = t.calls.map((c) => `${c.name}|${c.argsHash}`).join(',');
    if (sig === last && sig !== '') run++; else { max = Math.max(max, run); run = 1; }
    last = sig;
  }
  return Math.max(max, run);
}

function fuzzyRun() {
  let max = 0, run = 0, last = '';
  for (const t of turns) {
    const names = t.calls.map((c) => c.name).sort().join(',');
    if (names === last && names !== '') run++; else { max = Math.max(max, run); run = 1; }
    last = names;
  }
  return Math.max(max, run);
}

function dominanceFinding() {
  for (let i = DOMINANCE_WINDOW; i <= turns.length; i++) {
    const win = turns.slice(i - DOMINANCE_WINDOW, i);
    const cnt = new Map();
    let textT = 0;
    for (const t of win) {
      const p = t.calls[0]?.name ?? '';
      cnt.set(p, (cnt.get(p) ?? 0) + 1);
      if (turnHasText.get(t.msgId)) textT++;
    }
    let top = ['', 0];
    for (const [n, c] of cnt) if (c > top[1]) top = [n, c];
    if (top[1] / DOMINANCE_WINDOW >= DOMINANCE_RATIO && textT === 0) {
      return { window: [i - DOMINANCE_WINDOW, i], top, ratio: top[1] / DOMINANCE_WINDOW };
    }
  }
  return null;
}

function dupCapFinding() {
  const flat = [];
  for (const t of turns) for (const c of t.calls) flat.push(c);
  for (let i = DUP_CALL_WINDOW; i <= flat.length; i++) {
    const win = flat.slice(i - DUP_CALL_WINDOW, i);
    const cnt = new Map();
    for (const c of win) {
      const k = `${c.name}|${c.argsHash}`;
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
    let top = ['', 0];
    for (const [k, c] of cnt) if (c > top[1]) top = [k, c];
    if (top[1] >= DUP_CALL_THRESHOLD) {
      const name = top[0].split('|')[0];
      return { key: top[0], count: top[1], window: [i - DUP_CALL_WINDOW, i], polling: POLLING.test(name) };
    }
  }
  return null;
}

let telemetry = [];
try {
  telemetry = db.prepare(
    'SELECT turn, input_tokens, output_tokens, tool_count, compaction_triggered, summarizer_ran FROM coder_turn_telemetry WHERE session_id = ? ORDER BY turn'
  ).all(sessionId);
} catch { /* telemetry table may not exist on old DBs */ }

const sRun = strictRun();
const fRun = fuzzyRun();
const domF = dominanceFinding();
const dupF = dupCapFinding();
const compTurns = telemetry.filter((t) => t.compaction_triggered).length;
const sumTurns = telemetry.filter((t) => t.summarizer_ran).length;
const maxIn = telemetry.length ? Math.max(...telemetry.map((t) => t.input_tokens ?? 0)) : 0;

let r = `# Session ${sessionId} forensic report\n\n`;
r += `**Title**: ${session.title}\n`;
r += `**Provider/Model**: ${session.provider}/${session.model}\n`;
r += `**Status**: ${session.status}\n`;
r += `**Tokens**: in=${session.total_input_tokens.toLocaleString()} out=${session.total_output_tokens.toLocaleString()}\n\n`;
r += `## Summary\n- Total tool calls: ${total}\n- Turns with tools: ${turns.length}\n- Distinct tools: ${nameCount.size}\n- Avg calls/turn: ${turns.length ? (total / turns.length).toFixed(1) : 0}\n\n`;
r += `## Top tools by call count\n\n| Tool | Count | % |\n|---|---|---|\n`;
for (const [n, c] of tools.slice(0, 15)) r += `| \`${n}\` | ${c} | ${(c/total*100).toFixed(1)}% |\n`;
if (dom && domRatio > 0.3) {
  r += `\n⚠ **Dominant tool**: \`${dom[0]}\` = ${(domRatio*100).toFixed(1)}% of calls`;
  if (POLLING.test(dom[0])) r += ` (matches POLLING exemption — bypasses ALL guards via turnAllRepeatable)`;
  r += `\n`;
}
r += `\n## Repeated (tool, args) — top 10\n\n| Key | Count |\n|---|---|\n`;
for (const [k, c] of [...argCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) r += `| \`${k}\` | ${c} |\n`;
r += `\n## Repeated (tool, result) — top 10\n\n| Key | Count |\n|---|---|\n`;
for (const [k, c] of [...resCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) r += `| \`${k}\` | ${c} |\n`;
r += `\n## Guard diagnosis\n\n`;
r += `- doom-loop-strict (threshold ${DOOM_STRICT}): max consecutive identical-sig run = **${sRun}** ${sRun >= DOOM_STRICT ? '✗ SHOULD have fired' : '✓ ok'}\n`;
r += `- doom-loop-fuzzy (threshold ${DOOM_FUZZY}): max consecutive same-names run = **${fRun}** ${fRun >= DOOM_FUZZY ? '✗ SHOULD have fired' : '✓ ok'}\n`;
if (domF) r += `- dominance: ✗ SHOULD have fired in turn window ${domF.window.join('-')}: \`${domF.top[0]}\` ${domF.top[1]}/${DOMINANCE_WINDOW} (${(domF.ratio*100).toFixed(0)}%) zero-text\n`;
else r += `- dominance: ✓ ok (no ${DOMINANCE_RATIO*100}%+ single-tool window with zero text)\n`;
if (dupF) r += `- dup-call-cap: ${dupF.polling ? '⚠ POLLING-exempt' : '✗ SHOULD have fired'}: \`${dupF.key}\` (${dupF.count}× in window ${dupF.window.join('-')})\n`;
else r += `- dup-call-cap: ✓ ok (no (name, args) ≥${DUP_CALL_THRESHOLD}× in window of ${DUP_CALL_WINDOW})\n`;
r += `\n## Telemetry\n\n- Turns where compaction triggered: ${compTurns}\n- Turns where summarizer ran: ${sumTurns}\n- Max input_tokens in a single turn: ${maxIn.toLocaleString()}\n- Telemetry rows: ${telemetry.length}\n`;

console.log(r);
writeFileSync(`inspect-${sessionId}.md`, r);
console.error(`\nWrote inspect-${sessionId}.md`);
db.close();
