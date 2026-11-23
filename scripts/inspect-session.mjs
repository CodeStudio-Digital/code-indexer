#!/usr/bin/env node
// Read-only forensic dump for a filesystem session bundle.
// Usage: node scripts/inspect-session.mjs <bundle-path|session-uuid>

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { require as loadTypeScript } from 'tsx/cjs/api';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/inspect-session.mjs <bundle-path|session-uuid>');
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dataDir() {
  return process.env.MCP_DATA_DIR
    ?? resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.mcp-code-indexer');
}

function bundlePath(value) {
  const direct = resolve(value);
  if (existsSync(join(direct, 'session.json'))) return direct;
  if (!UUID.test(value)) return direct;
  const candidates = [
    resolve('.mcp-indexer', 'session', value),
    resolve(dataDir(), 'sessions', 'global', value),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'session.json')))
    ?? direct;
}

const bundle = bundlePath(input);
if (!existsSync(join(bundle, 'session.json')) || !statSync(bundle).isDirectory()) {
  console.error(`Filesystem session bundle not found: ${bundle}`);
  process.exit(1);
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const session = json(join(bundle, 'session.json'));
const state = json(join(bundle, 'state.json'));
if (!UUID.test(session.id) || basename(bundle).toLowerCase() !== session.id.toLowerCase()) {
  throw new Error('session.json identity does not match its bundle directory');
}

const { sessionJournalPath } = loadTypeScript('../packages/session-storage/src/session-journal-path.ts', import.meta.url);
const { readConversationSync } = loadTypeScript('../packages/session-storage/src/session-writer.ts', import.meta.url);
const commits = readConversationSync(sessionJournalPath(bundle));

const messages = new Map();
let calls = [];
for (const commit of commits) {
  const payload = commit.payload;
  if (payload?.type !== 'coder.turn') continue;
  if (Number.isSafeInteger(payload.truncate_from_seq)) {
    for (const seq of messages.keys()) {
      if (seq >= payload.truncate_from_seq) messages.delete(seq);
    }
    calls = calls.filter((call) => call.message_seq < payload.truncate_from_seq);
  }
  for (const patch of payload.message_patches ?? []) {
    const current = messages.get(patch.seq);
    if (current) messages.set(patch.seq, { ...current, ...patch });
  }
  for (const message of payload.messages ?? []) {
    messages.set(message.seq, message);
  }
  calls.push(...(payload.tool_calls ?? []));
}

const sha = (value) =>
  createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 12);

const turnHasText = new Map();
for (const message of messages.values()) {
  if (message.role !== 'assistant') continue;
  turnHasText.set(
    message.seq,
    Array.isArray(message.content)
      && message.content.some(
        (block) => block?.type === 'text' && String(block.text ?? '').trim(),
      ),
  );
}

const turns = [];
let last = null;
for (const call of calls) {
  if (call.message_seq !== last) {
    turns.push({ msgId: call.message_seq, calls: [] });
    last = call.message_seq;
  }
  const outputRef = call.output?.shaped ?? call.output?.raw ?? null;
  turns.at(-1).calls.push({
    name: call.tool_name,
    argsHash: sha(call.args),
    resultHash: outputRef?.sha256?.slice(0, 12) ?? null,
    isError: call.is_error === true,
    resultLen: outputRef?.size ?? 0,
  });
}

const DOOM_STRICT = 3;
const DOOM_FUZZY = 6;
const DOMINANCE_WINDOW = 6;
const DOMINANCE_RATIO = 0.8;
const DUP_CALL_THRESHOLD = 5;
const DUP_CALL_WINDOW = 20;
const POLLING = /(?:^|__)(?:wait_for|await|poll|tail|monitor|list)_|_(?:status|logs|pulse|stats)$/;

const nameCount = new Map();
const argCount = new Map();
const resultCount = new Map();
for (const turn of turns) {
  for (const call of turn.calls) {
    nameCount.set(call.name, (nameCount.get(call.name) ?? 0) + 1);
    const argKey = `${call.name}|${call.argsHash}`;
    argCount.set(argKey, (argCount.get(argKey) ?? 0) + 1);
    if (call.resultHash) {
      const resultKey = `${call.name}|${call.resultHash}`;
      resultCount.set(resultKey, (resultCount.get(resultKey) ?? 0) + 1);
    }
  }
}

function repeatedRun(signature) {
  let max = 0;
  let run = 0;
  let previous = '';
  for (const turn of turns) {
    const current = signature(turn);
    if (current === previous && current !== '') run += 1;
    else {
      max = Math.max(max, run);
      run = 1;
    }
    previous = current;
  }
  return Math.max(max, run);
}

function dominanceFinding() {
  for (let index = DOMINANCE_WINDOW; index <= turns.length; index += 1) {
    const window = turns.slice(index - DOMINANCE_WINDOW, index);
    const counts = new Map();
    let textTurns = 0;
    for (const turn of window) {
      const primary = turn.calls[0]?.name ?? '';
      counts.set(primary, (counts.get(primary) ?? 0) + 1);
      if (turnHasText.get(turn.msgId)) textTurns += 1;
    }
    const top = [...counts].sort((left, right) => right[1] - left[1])[0] ?? ['', 0];
    if (top[1] / DOMINANCE_WINDOW >= DOMINANCE_RATIO && textTurns === 0) {
      return {
        window: [index - DOMINANCE_WINDOW, index],
        top,
        ratio: top[1] / DOMINANCE_WINDOW,
      };
    }
  }
  return null;
}

function duplicateFinding() {
  const flat = turns.flatMap((turn) => turn.calls);
  for (let index = DUP_CALL_WINDOW; index <= flat.length; index += 1) {
    const counts = new Map();
    for (const call of flat.slice(index - DUP_CALL_WINDOW, index)) {
      const key = `${call.name}|${call.argsHash}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const top = [...counts].sort((left, right) => right[1] - left[1])[0] ?? ['', 0];
    if (top[1] >= DUP_CALL_THRESHOLD) {
      const name = top[0].split('|')[0];
      return {
        key: top[0],
        count: top[1],
        window: [index - DUP_CALL_WINDOW, index],
        polling: POLLING.test(name),
      };
    }
  }
  return null;
}

const total = calls.length;
const tools = [...nameCount].sort((left, right) => right[1] - left[1]);
const dominant = tools[0];
const dominantRatio = dominant && total > 0 ? dominant[1] / total : 0;
const strictRun = repeatedRun((turn) =>
  turn.calls.map((call) => `${call.name}|${call.argsHash}`).join(','),
);
const fuzzyRun = repeatedRun((turn) =>
  turn.calls.map((call) => call.name).sort().join(','),
);
const dominance = dominanceFinding();
const duplicate = duplicateFinding();
const metricsPath = join(bundle, 'metrics', 'summary.json');
const metrics = existsSync(metricsPath) ? json(metricsPath) : null;

let report = `# Session ${session.id} forensic report\n\n`;
report += `**Bundle**: \`${bundle}\`\n`;
report += `**Title**: ${session.title ?? ''}\n`;
report += `**Provider/Model**: ${session.provider ?? ''}/${session.model ?? ''}\n`;
report += `**Status**: ${state.status}\n`;
report += `**Tokens**: in=${(metrics?.tokens?.input ?? 0).toLocaleString()} out=${(metrics?.tokens?.output ?? 0).toLocaleString()}\n\n`;
report += `## Summary\n- Conversation commits: ${commits.length}\n- Total tool calls: ${total}\n- Turns with tools: ${turns.length}\n- Distinct tools: ${nameCount.size}\n- Avg calls/turn: ${turns.length ? (total / turns.length).toFixed(1) : 0}\n\n`;
report += '## Top tools by call count\n\n| Tool | Count | % |\n|---|---|---|\n';
for (const [name, count] of tools.slice(0, 15)) {
  report += `| \`${name}\` | ${count} | ${total ? (count / total * 100).toFixed(1) : '0.0'}% |\n`;
}
if (dominant && dominantRatio > 0.3) {
  report += `\n⚠ **Dominant tool**: \`${dominant[0]}\` = ${(dominantRatio * 100).toFixed(1)}% of calls`;
  if (POLLING.test(dominant[0])) report += ' (matches POLLING exemption)';
  report += '\n';
}
report += '\n## Repeated (tool, args) — top 10\n\n| Key | Count |\n|---|---|\n';
for (const [key, count] of [...argCount].sort((left, right) => right[1] - left[1]).slice(0, 10)) {
  report += `| \`${key}\` | ${count} |\n`;
}
report += '\n## Repeated (tool, result artifact) — top 10\n\n| Key | Count |\n|---|---|\n';
for (const [key, count] of [...resultCount].sort((left, right) => right[1] - left[1]).slice(0, 10)) {
  report += `| \`${key}\` | ${count} |\n`;
}
report += '\n## Guard diagnosis\n\n';
report += `- doom-loop-strict (threshold ${DOOM_STRICT}): max consecutive identical-sig run = **${strictRun}** ${strictRun >= DOOM_STRICT ? '✗ SHOULD have fired' : '✓ ok'}\n`;
report += `- doom-loop-fuzzy (threshold ${DOOM_FUZZY}): max consecutive same-names run = **${fuzzyRun}** ${fuzzyRun >= DOOM_FUZZY ? '✗ SHOULD have fired' : '✓ ok'}\n`;
report += dominance
  ? `- dominance: ✗ SHOULD have fired in turn window ${dominance.window.join('-')}: \`${dominance.top[0]}\` ${dominance.top[1]}/${DOMINANCE_WINDOW} (${(dominance.ratio * 100).toFixed(0)}%) zero-text\n`
  : `- dominance: ✓ ok (no ${DOMINANCE_RATIO * 100}%+ single-tool window with zero text)\n`;
report += duplicate
  ? `- dup-call-cap: ${duplicate.polling ? '⚠ POLLING-exempt' : '✗ SHOULD have fired'}: \`${duplicate.key}\` (${duplicate.count}× in window ${duplicate.window.join('-')})\n`
  : `- dup-call-cap: ✓ ok (no (name, args) ≥${DUP_CALL_THRESHOLD}× in window of ${DUP_CALL_WINDOW})\n`;

console.log(report);
const outputPath = resolve(`inspect-${session.id}.md`);
writeFileSync(outputPath, report);
console.error(`\nWrote ${outputPath}`);
