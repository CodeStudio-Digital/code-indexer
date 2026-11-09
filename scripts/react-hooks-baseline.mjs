import { createHash } from 'node:crypto';
import { relative } from 'node:path';

/** Position-independent, but tied to file, rule, diagnostic and offending code. */
export function reactDiagnostic(root, result, message) {
  const file = relative(root, result.filePath).replaceAll('\\', '/');
  const lines = (result.source ?? '').split(/\r?\n/);
  const line = lines[(message.line ?? 1) - 1] ?? '';
  const endLine = message.endLine ?? message.line ?? 1;
  const excerpt = endLine === message.line
    ? line.slice(Math.max(0, (message.column ?? 1) - 1), message.endColumn ? message.endColumn - 1 : undefined).trim()
    : lines.slice(Math.max(0, (message.line ?? 1) - 1), endLine).map(value => value.trim()).join('\n');
  const description = message.message.split(/\r?\n\r?\n/)[0].replace(/\bat line \d+\b/g, 'at line');
  const rule = message.ruleId ?? (message.fatal ? 'parse-error' : 'eslint');
  const fingerprint = createHash('sha256').update(JSON.stringify([file, rule, description, excerpt])).digest('hex');
  return { fingerprint, file, rule, description, excerpt, line: message.line ?? 1, column: message.column ?? 1 };
}

export function compareReactDiagnostics(actual, baseline) {
  const remaining = new Map(baseline.map(row => [row.fingerprint, row.count]));
  const regressions = [];
  let existing = 0;
  for (const row of actual) {
    const count = remaining.get(row.fingerprint) ?? 0;
    if (count > 0) { remaining.set(row.fingerprint, count - 1); existing++; }
    else regressions.push(row);
  }
  return { regressions, existing, resolved: [...remaining.values()].reduce((sum, count) => sum + count, 0) };
}
