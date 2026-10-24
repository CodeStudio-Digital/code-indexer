import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, '..', '..');
const repoRoot = resolve(dashboardRoot, '..', '..');
const localesRoot = resolve(dashboardRoot, 'i18n', 'locales');

function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out[prefix] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

type LiteralBaseline = {
  visibleJsx: Record<string, number>;
  dialogCalls: Record<string, number>;
};

type LiteralItem = {
  file: string;
  line: number;
  kind: string;
  text: string;
};

type TranslationBinding = {
  name: string;
  namespaces: string[];
  scope: ts.Node;
};

type TranslationReference = {
  file: string;
  line: number;
  key: string;
  namespace: string;
};

const syntaxCache = new Map<string, ts.SourceFile>();
function sourceFile(file: string): ts.SourceFile {
  let cached = syntaxCache.get(file);
  if (!cached) {
    cached = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    syntaxCache.set(file, cached);
  }
  return cached;
}
let dashboardFiles: string[] | undefined;
function dashboardSource(): string[] { return dashboardFiles ??= walkDashboardSource(); }

const literalBaseline = readJson(join(here, 'literal-baseline.json')) as LiteralBaseline;

describe('dashboard i18n catalogs', () => {
  it('keeps pt-BR and en namespace keys in parity', () => {
    const ptFiles = readdirSync(join(localesRoot, 'pt-BR')).filter((f) => f.endsWith('.json')).sort();
    const enFiles = readdirSync(join(localesRoot, 'en')).filter((f) => f.endsWith('.json')).sort();
    expect(enFiles).toEqual(ptFiles);

    const failures: string[] = [];
    for (const file of ptFiles) {
      const pt = flatten(readJson(join(localesRoot, 'pt-BR', file)));
      const en = flatten(readJson(join(localesRoot, 'en', file)));
      for (const key of Object.keys(pt)) {
        if (!(key in en)) failures.push(`${file}: missing en.${key}`);
      }
      for (const key of Object.keys(en)) {
        if (!(key in pt)) failures.push(`${file}: missing pt-BR.${key}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('defines every statically referenced translation key', () => {
    const catalogs = new Map<string, Set<string>>();
    for (const file of readdirSync(join(localesRoot, 'pt-BR')).filter((name) => name.endsWith('.json'))) {
      catalogs.set(file.replace(/\.json$/, ''), new Set(Object.keys(flatten(readJson(join(localesRoot, 'pt-BR', file))))));
    }

    const failures = dashboardSource()
      .flatMap(scanStaticTranslationReferences)
      .filter(({ namespace, key }) => {
        const catalog = catalogs.get(namespace);
        return !catalog || (!catalog.has(key) && ![...catalog].some((candidate) => (
          candidate.startsWith(`${key}.`) || candidate.startsWith(`${key}_`)
        )));
      })
      .map(({ file, line, namespace, key }) => `${file}:${line} missing ${namespace}:${key}`)
      .sort();

    expect(failures).toEqual([]);
  });
});

function staticString(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function translationNamespaces(call: ts.CallExpression): string[] | null {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'useTranslation') return null;
  const namespaceArg = call.arguments[0];
  if (!namespaceArg) return ['common'];
  const namespace = staticString(namespaceArg);
  if (namespace) return [namespace];
  if (!ts.isArrayLiteralExpression(namespaceArg)) return null;
  const namespaces = namespaceArg.elements.map(staticString);
  return namespaces.every((candidate): candidate is string => candidate != null) ? namespaces : null;
}

function bindingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

function translationBindings(sf: ts.SourceFile): TranslationBinding[] {
  const bindings: TranslationBinding[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const namespaces = translationNamespaces(node.initializer);
      if (namespaces) {
        for (const element of node.name.elements) {
          const property = element.propertyName?.getText(sf) ?? element.name.getText(sf);
          if (property === 't' && ts.isIdentifier(element.name)) {
            bindings.push({ name: element.name.text, namespaces, scope: bindingScope(node) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return bindings;
}

function namespaceOption(call: ts.CallExpression): string | null {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'ns') continue;
    return staticString(property.initializer);
  }
  return null;
}

function scanStaticTranslationReferences(file: string): TranslationReference[] {
    const relativePath = relative(repoRoot, file).replace(/\\/g, '/');
  const sf = sourceFile(file);
  const bindings = translationBindings(sf);
  const references: TranslationReference[] = [];

  function add(call: ts.CallExpression, namespaces: string[]): void {
    const rawKey = staticString(call.arguments[0]);
    if (!rawKey) return;
    const separator = rawKey.indexOf(':');
    const namespace = separator > 0
      ? rawKey.slice(0, separator)
      : namespaceOption(call) ?? namespaces[0];
    const key = separator > 0 ? rawKey.slice(separator + 1) : rawKey;
    if (!namespace || !key) return;
    references.push({
      file: relativePath,
      line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
      key,
      namespace,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const callName = node.expression.text;
        const binding = bindings
          .filter(({ name, scope }) => (
            name === callName &&
            scope.getStart(sf) <= node.getStart(sf) &&
            scope.end >= node.end
          ))
          .sort((a, b) => (a.scope.end - a.scope.getStart(sf)) - (b.scope.end - b.scope.getStart(sf)))[0];
        if (binding) add(node, binding.namespaces);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 't' &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'i18n'
      ) {
        add(node, ['common']);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return references;
}

const protectedDashboardFiles = [
  'apps/dashboard/AppShell.tsx',
  'apps/dashboard/components/FallbackPicker.tsx',
  'apps/dashboard/components/ui/dialog.tsx',
  'apps/dashboard/components/ui/prompt-dialog.tsx',
  'apps/dashboard/features/admin/ChromeServicePanel.tsx',
  'apps/dashboard/features/admin/PipelineBindingsPanel.tsx',
  'apps/dashboard/features/admin/PluginsPanel.tsx',
  'apps/dashboard/features/admin/SkillsInstallDialog.tsx',
  'apps/dashboard/features/admin/SkillsInstallLocalDialog.tsx',
  'apps/dashboard/features/admin/SkillsInstallUrlDialog.tsx',
  'apps/dashboard/features/admin/SupervisorPanel.tsx',
  'apps/dashboard/features/agents/tests/history/RunDetailModal.tsx',
  'apps/dashboard/features/agents/tests/history/RunHistoryTable.tsx',
  'apps/dashboard/features/agents/tests/live/LiveRunView.tsx',
  'apps/dashboard/features/agents/tests/shared/QaStatusBadge.tsx',
  'apps/dashboard/features/agents/tests/shared/UrlsDrawer.tsx',
  'apps/dashboard/features/builder/preview/ProjectSelect.tsx',
  'apps/dashboard/features/chat/ToolStatsModal.tsx',
  'apps/dashboard/features/onboarding/OnboardingWizard.tsx',
  'apps/dashboard/features/project/tabs/FilesTab.tsx',
  'apps/dashboard/features/snapshots/SnapshotDiffViewer.tsx',
  'apps/dashboard/features/snapshots/snapshots-panel-view.tsx',
  'apps/dashboard/features/snapshots/diff/DiffRow.tsx',
  'apps/dashboard/features/snapshots/diff/ReviewComment.tsx',
  'apps/dashboard/features/workspace/jetbrains/tool-windows/GitWindow.tsx',
  'apps/dashboard/features/workspace/jetbrains/tool-windows/WebviewWindow.tsx',
];

const protectedAllowlist = new Map<string, Set<string>>([
  ['apps/dashboard/AppShell.tsx', new Set(['CodeStudio', 'v'])],
  // Brand wordmark + version prefix moved out of AppShell into the app menu.
  ['apps/dashboard/components/AppMenu.tsx', new Set(['CodeStudio', 'v'])],
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

function literalSignature(item: Pick<LiteralItem, 'file' | 'kind' | 'text'>): string {
  return `${item.file}|${item.kind}|${item.text}`;
}

function unexpectedLiterals(items: LiteralItem[], baseline: Record<string, number>): string[] {
  const counts = new Map<string, number>();
  const locations = new Map<string, LiteralItem>();
  for (const item of items) {
    const signature = literalSignature(item);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
    locations.set(signature, locations.get(signature) ?? item);
  }

  return [...counts.entries()]
    .filter(([signature, count]) => count > (baseline[signature] ?? 0))
    .map(([signature, count]) => {
      const item = locations.get(signature)!;
      return `${item.file}:${item.line} ${item.kind} "${item.text}" (count ${count}, baseline ${baseline[signature] ?? 0})`;
    })
    .sort();
}

function walkDashboardSource(dir = dashboardRoot, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.vite'].includes(entry)) continue;
    const path = join(dir, entry);
    // The synthetic renderer benchmark is test input, not a product surface.
    if (relative(dashboardRoot, path).replace(/\\/g, '/') === 'performance/renderer/fixture.tsx') continue;
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

function scanVisibleJsxItems(relativePath: string): LiteralItem[] {
  const file = join(repoRoot, relativePath);
    const sf = sourceFile(file);
  const allowed = protectedAllowlist.get(relativePath) ?? new Set<string>();
  const items: LiteralItem[] = [];

  function lineOf(node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  function add(kind: string, node: ts.Node, raw: string): void {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text || !textish.test(text) || punctuationOnly.test(text) || allowed.has(text)) return;
    items.push({ file: relativePath, line: lineOf(node), kind, text });
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) add('jsxText', node, node.getText(sf));
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      ['title', 'aria-label', 'placeholder', 'alt'].includes(node.name.getText(sf))
    ) {
      add(`attr:${node.name.getText(sf)}`, node, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return items;
}

function scanVisibleJsxLiterals(relativePath: string): string[] {
  return scanVisibleJsxItems(relativePath).map((item) => `${item.file}:${item.line} ${item.kind} "${item.text}"`);
}

function dialogCallKind(expr: ts.Expression, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(expr) && ['confirm', 'prompt', 'alert', 'toast'].includes(expr.text)) return expr.text;
  if (!ts.isPropertyAccessExpression(expr)) return null;

  const name = expr.name.text;
  const base = expr.expression.getText(sf);
  if (['confirm', 'prompt', 'alert'].includes(name) && /(?:^|\.)window$/.test(base)) return name;
  if (/\btoast\b/.test(base) && ['success', 'error', 'info', 'warning', 'warn', 'promise'].includes(name)) return `toast.${name}`;
  return null;
}

function scanDialogCallItems(file: string): LiteralItem[] {
    const relativePath = relative(repoRoot, file).replace(/\\/g, '/');
  const sf = sourceFile(file);
  const items: LiteralItem[] = [];

  function lineOf(node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const kind = dialogCallKind(node.expression, sf);
      if (kind) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteralLike(arg)) {
            const text = arg.text.replace(/\s+/g, ' ').trim();
            if (text && textish.test(text) && !punctuationOnly.test(text)) {
              items.push({ file: relativePath, line: lineOf(arg), kind, text });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return items;
}

describe('dashboard visible literals', () => {
  it('keeps migrated dashboard surfaces free of raw visible text', () => {
    const failures = protectedDashboardFiles.flatMap(scanVisibleJsxLiterals);
    expect(failures).toEqual([]);
  });

  it('blocks new raw visible JSX text across dashboard files', () => {
    const items = dashboardSource()
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) => scanVisibleJsxItems(relative(repoRoot, file).replace(/\\/g, '/')));
    expect(unexpectedLiterals(items, literalBaseline.visibleJsx)).toEqual([]);
  });

  it('blocks new raw confirm, prompt, alert, and toast literals', () => {
    const items = dashboardSource().flatMap(scanDialogCallItems);
    expect(unexpectedLiterals(items, literalBaseline.dialogCalls)).toEqual([]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.pytest_cache', '__pycache__'].includes(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (path.endsWith('.html')) out.push(path);
  }
  return out;
}

const technicalPluginLiteral = /^(?:Cloudflare|D1|KV|R2|DNS|SQL|CORS|Cron|Workers|Vectorize|Hyperdrive|Pages|Durable Objects|AI|LG|AS|ST|WK|PG|DN|VX|QU|DO|Name|Value|Type|Content|Key|TTL|OK)$/;
const codeLikePluginLiteral = /^(?:cf_|ui\/|[a-z]+(?:-[a-z]+)+|[A-Z0-9_]+|\*\/|SELECT |text\/plain|cosine|euclidean|dot-product|tail|login)/;

function cloudflareUiKeys(html: string): Set<string> {
  return new Set([...html.matchAll(/^\s*'([^']+)':\s*'/gm)].map((m) => m[1]));
}

function helperLiterals(html: string): string[] {
  const patterns = [
    /\bbutton\('([^']*[A-Za-zÀ-ÿ][^']*)'/g,
    /\bemptyBox\('([^']*[A-Za-zÀ-ÿ][^']*)'/g,
    /\bfieldsModal\('([^']*[A-Za-zÀ-ÿ][^']*)'/g,
    /\bmutate\([^;\n]+,\s*'([^']*[A-Za-zÀ-ÿ][^']*)'\)/g,
    /\b(?:group|title|sub|label|placeholder):\s*'([^']*[A-Za-zÀ-ÿ][^']*)'/g,
    /placeholder\s*=\s*uiText\('([^']*[A-Za-zÀ-ÿ][^']*)'\)/g,
    /uiText\('([^']*[A-Za-zÀ-ÿ][^']*)'/g,
  ];
  return patterns.flatMap((pattern) => [...html.matchAll(pattern)].map((m) => m[1]));
}

describe('plugin webview i18n', () => {
  it('keeps bundled plugin UI HTML initialized without static English copy', () => {
    const failures: string[] = [];
    // Only source UI owned by a plugin belongs to this catalog. Backup trees,
    // installed SDKs and generated bundles are not additional plugin sources.
    const extensionsRoot = resolve(repoRoot, 'extensions');
    const pluginUiFiles = readdirSync(extensionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(extensionsRoot, entry.name))
      .filter((root) => existsSync(join(root, 'plugin.json')) && existsSync(join(root, 'ui')))
      .flatMap((root) => walk(join(root, 'ui')));
    for (const file of pluginUiFiles) {
      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      if (!rel.includes('/ui/')) continue;
      const beforeScript = readFileSync(file, 'utf8').split(/<script\b/i)[0] ?? '';
      for (const match of beforeScript.matchAll(/>([^<>{}]*[A-Za-zÀ-ÿ][^<>{}]*)</g)) {
        const text = match[1].replace(/\s+/g, ' ').trim();
        if (text && text !== 'Cloudflare') failures.push(`${rel}: static text "${text}"`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('routes Cloudflare panel helper literals through its local catalog', () => {
    const file = resolve(repoRoot, 'extensions/cloudflare/ui/panel.html');
    const html = readFileSync(file, 'utf8');
    const catalog = cloudflareUiKeys(html);
    const failures = [...new Set(helperLiterals(html))]
      .filter((text) => !catalog.has(text))
      .filter((text) => !technicalPluginLiteral.test(text))
      .filter((text) => !codeLikePluginLiteral.test(text))
      .filter((text) => !/^Insert row into |^Update row /.test(text))
      .sort();

    expect(failures).toEqual([]);
  });
});
