/**
 * Regenerate apps/dashboard/i18n/__tests__/literal-baseline.json from the
 * CURRENT source — run after intentionally adding/moving user-visible
 * literals (the i18n-coverage test is a ratchet against new ones).
 *
 * MIRROR of the scanner in i18n-coverage.test.ts (walk + jsx/attr scan +
 * dialog-call scan + allowlist). If that test's rules change, change this
 * script the same way.
 *
 * Usage: node scripts/update-literal-baseline.mjs
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dashboardRoot = resolve(repoRoot, 'apps', 'dashboard');
const baselinePath = resolve(dashboardRoot, 'i18n', '__tests__', 'literal-baseline.json');

const protectedAllowlist = new Map([
  ['apps/dashboard/AppShell.tsx', new Set(['CodeStudio', 'v'])],
  ['apps/dashboard/features/admin/ChromeServicePanel.tsx', new Set(['· CDP'])],
  ['apps/dashboard/features/admin/PipelineBindingsPanel.tsx', new Set(['global', 'template', 'session'])],
  ['apps/dashboard/features/admin/PluginsPanel.tsx', new Set(['v', 'MCP_MARKET_URL'])],
  ['apps/dashboard/features/admin/SkillsInstallLocalDialog.tsx', new Set(['C:\\Users\\...\\my-skills'])],
  ['apps/dashboard/features/admin/SkillsInstallUrlDialog.tsx', new Set(['https://mcp.directory/skills/<slug>'])],
  ['apps/dashboard/features/agents/tests/history/RunDetailModal.tsx', new Set(['summary.md'])],
  ['apps/dashboard/features/chat/ToolStatsModal.tsx', new Set(['ms'])],
  ['apps/dashboard/features/onboarding/OnboardingWizard.tsx', new Set(['my-app'])],
  ['apps/dashboard/features/workspace/jetbrains/tool-windows/GitWindow.tsx', new Set(['Git'])],
]);

const textish = /[A-Za-zÀ-ÿ]/;
const punctuationOnly = /^[\s\d.,:;!?()[\]{}#/+\-*|·–—<>%$&='"`\\]+$/;

function walkDashboardSource(dir = dashboardRoot, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.vite'].includes(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (relative(dashboardRoot, path).replace(/\\/g, '/') === 'i18n/__tests__') continue;
      walkDashboardSource(path, out);
    } else if (/\.[cm]?[tj]sx?$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

function scanVisibleJsxItems(relativePath) {
  const file = join(repoRoot, relativePath);
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const allowed = protectedAllowlist.get(relativePath) ?? new Set();
  const items = [];
  const add = (kind, raw) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text || !textish.test(text) || punctuationOnly.test(text) || allowed.has(text)) return;
    items.push({ file: relativePath, kind, text });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add('jsxText', node.getText(sf));
    if (
      ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) &&
      ['title', 'aria-label', 'placeholder', 'alt'].includes(node.name.getText(sf))
    ) {
      add(`attr:${node.name.getText(sf)}`, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return items;
}

function dialogCallKind(expr, sf) {
  if (ts.isIdentifier(expr) && ['confirm', 'prompt', 'alert', 'toast'].includes(expr.text)) return expr.text;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  const name = expr.name.text;
  const base = expr.expression.getText(sf);
  if (['confirm', 'prompt', 'alert'].includes(name) && /(?:^|\.)window$/.test(base)) return name;
  if (/\btoast\b/.test(base) && ['success', 'error', 'info', 'warning', 'warn', 'promise'].includes(name)) return `toast.${name}`;
  return null;
}

function scanDialogCallItems(file) {
  const source = readFileSync(file, 'utf8');
  const relativePath = relative(repoRoot, file).replace(/\\/g, '/');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const items = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const kind = dialogCallKind(node.expression, sf);
      if (kind) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteralLike(arg)) {
            const text = arg.text.replace(/\s+/g, ' ').trim();
            if (text && textish.test(text) && !punctuationOnly.test(text)) {
              items.push({ file: relativePath, kind, text });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return items;
}

function toCounts(items) {
  const counts = {};
  for (const item of items) {
    const sig = `${item.file}|${item.kind}|${item.text}`;
    counts[sig] = (counts[sig] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const files = walkDashboardSource();
const visibleJsx = toCounts(
  files.filter((f) => f.endsWith('.tsx')).flatMap((f) => scanVisibleJsxItems(relative(repoRoot, f).replace(/\\/g, '/'))),
);
const dialogCalls = toCounts(files.flatMap(scanDialogCallItems));

const prev = JSON.parse(readFileSync(baselinePath, 'utf8'));
const prevTotal = Object.keys(prev.visibleJsx).length + Object.keys(prev.dialogCalls).length;
const nextTotal = Object.keys(visibleJsx).length + Object.keys(dialogCalls).length;

writeFileSync(baselinePath, `${JSON.stringify({ visibleJsx, dialogCalls }, null, 2)}\n`);
console.log(`[literal-baseline] ${prevTotal} → ${nextTotal} signatures (${nextTotal - prevTotal >= 0 ? '+' : ''}${nextTotal - prevTotal})`);
