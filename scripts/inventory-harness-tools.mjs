// Read-only TypeScript AST inventory. Does not load providers, tools or user data.
import ts from 'typescript';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';

const root = resolve('.');
const roots = [
  ['coder', 'packages/code-agent/src/tools'],
  ['skills', 'packages/code-agent/src/skills/skill-tool-builder.ts'],
  ['company', 'packages/company/src/tools'],
  ['docs-agent', 'packages/docs-agent/src/tools'],
  ['coder', 'packages/docs-agent/src/bridges/docs-bridge.ts'],
  ['mcp-internal', 'apps/mcp-server/tools'],
  ['plugin', 'packages/plugin-host/src/plugin-tool-bridge.ts'],
  ['external-mcp', 'apps/http-api/workers/RemoteMcpServerManager.ts'],
];
const definitions = [];
const dynamic = [];
const seenFiles = [];
const strings = node => {
  const result = [];
  const visit = current => {
    if (ts.isStringLiteral(current)) result.push(current.text);
    else ts.forEachChild(current, visit);
  };
  visit(node); return result;
};
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const nativePath = 'apps/http-api/workers/native-coder-catalog.ts';
const nativeFile = parse(nativePath, await readFile(nativePath, 'utf8'));
let nativeNames = [];
let nativeChildNames = [];
function nativeVisit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(nativeFile) === 'NATIVE_CODER_TOOL_NAMES') {
    nativeNames = strings(node.initializer);
  } else if (ts.isVariableDeclaration(node) && node.name.getText(nativeFile) === 'NATIVE_CODER_CHILD_TOOL_NAMES') {
    nativeChildNames = strings(node.initializer);
  } else ts.forEachChild(node, nativeVisit);
}
nativeVisit(nativeFile);
const enabled = new Set(nativeNames);
const childEnabled = new Set(nativeChildNames);

async function files(path) {
  if (path.endsWith('.ts')) return [path];
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    // Generated discovery metadata is a copy, not another tool implementation.
    if (/^(__tests__|__fixtures__|fixtures|generated)$/.test(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await files(child));
    else if (entry.name.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(entry.name)) result.push(child);
  }
  return result;
}
for (const [surface, directory] of roots) {
  for (const path of await files(directory)) {
    const file = relative(root, resolve(path)).replaceAll('\\', '/');
    const source = parse(file, await readFile(path, 'utf8'));
    seenFiles.push(file);
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const properties = new Map(node.properties.filter(p => p.name).map(p => [p.name.getText(source).replace(/^['"]|['"]$/g, ''), p]));
        const name = properties.get('name');
        const looksLikeTool = properties.has('handler')
          || ((properties.has('parameters') || properties.has('inputSchema')) && properties.has('description'));
        if (name && looksLikeTool) {
          const expression = ts.isPropertyAssignment(name) ? name.initializer : name.name;
          const location = { file, line: source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1 };
          let names = ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? [expression.text] : [];
          // Resolve a finite local factory such as controlTool('restart') whose
          // name is `service_${op}`. Never execute the tool or infer remote names.
          if (ts.isTemplateExpression(expression) && expression.templateSpans.length === 1) {
            const span = expression.templateSpans[0];
            let parent = node.parent;
            while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
            if (parent?.name && ts.isIdentifier(span.expression)) {
              const parameterIndex = parent.parameters.findIndex(p => p.name.getText(source) === span.expression.text);
              const factoryName = parent.name.text;
              const calls = current => {
                if (parameterIndex >= 0 && ts.isCallExpression(current) && current.expression.getText(source) === factoryName) {
                  const argument = current.arguments[parameterIndex];
                  if (argument && ts.isStringLiteral(argument)) names.push(expression.head.text + argument.text + span.literal.text);
                }
                ts.forEachChild(current, calls);
              };
              calls(source);
            }
          }
          if (names.length) {
            for (const declaredName of [...new Set(names)]) {
            const wireName = surface === 'mcp-internal' ? `mcp__${declaredName}` : declaredName;
            const metadata = {};
            for (const key of ['mutates', 'parallelSafe', 'riskLevel', 'effectBoundary', 'timeoutMs', 'interactive', 'repeatPolicy', 'outputPolicy']) {
              const prop = properties.get(key);
              if (prop && ts.isPropertyAssignment(prop)) metadata[key] = prop.initializer.getText(source);
            }
            definitions.push({ name: wireName, declaredName, surface, ...location, metadata,
              nativeStatus: enabled.has(wireName) ? 'enabled_development'
                : childEnabled.has(wireName) ? 'enabled_child_development' : 'pending_integration' });
            }
          } else dynamic.push({ surface, ...location, expression: expression.getText(source) });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
definitions.sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
const groups = {};
for (const item of definitions) {
  (groups[item.surface] ??= { enabled: [], contextual: [], pending: [] })[
    item.nativeStatus === 'pending_integration' ? 'pending' : item.nativeStatus === 'enabled_child_development' ? 'contextual' : 'enabled'].push(item.name);
}
for (const group of Object.values(groups)) {
  group.enabled = [...new Set(group.enabled)]; group.contextual = [...new Set(group.contextual)]; group.pending = [...new Set(group.pending)];
}
const report = { schemaVersion: 2, checkedAt: new Date().toISOString(),
  scope: 'Static first-party tool definitions, including conditional roles and compatibility aliases. MCP names include the coder bridge prefix. Native enablement is not production certification.',
  nativeCatalog: nativePath, nativeNames, nativeChildNames, groups, definitions, dynamic,
  unresolvedNativeNames: [...nativeNames, ...nativeChildNames].filter(name => !definitions.some(tool => tool.name === name)),
  filesScanned: seenFiles.length };
report.tierOnlyNames = [];
for (const file of ['packages/code-agent/src/tools/tiers.ts', 'packages/code-agent/src/tools/tiers-company.ts']) {
  const source = parse(file, await readFile(file, 'utf8'));
  function visit(node) {
    if (ts.isVariableDeclaration(node) && /_TOOLS$/.test(node.name.getText(source)) && node.initializer) {
      for (const name of strings(node.initializer)) {
        if (!definitions.some(tool => tool.name === name)) report.tierOnlyNames.push({ name, file });
      }
    } else ts.forEachChild(node, visit);
  }
  visit(source);
}
report.counts = { names: new Set(definitions.map(d => d.name)).size,
  enabled: new Set(definitions.filter(d => d.nativeStatus !== 'pending_integration').map(d => d.name)).size,
  rootEnabled: new Set(definitions.filter(d => d.nativeStatus === 'enabled_development').map(d => d.name)).size,
  childOnly: new Set(definitions.filter(d => d.nativeStatus === 'enabled_child_development').map(d => d.name)).size,
  pending: new Set(definitions.filter(d => d.nativeStatus === 'pending_integration').map(d => d.name)).size };
const args = process.argv.slice(2);
const output = resolve(args.find(arg => !arg.startsWith('--'))
  ?? 'docs/architecture/rust-agent-runtime/tool-inventory.json');
const markdownPath = output.replace(/\.json$/, '') + '.md';
function markdown() {
  const lines = [
    '# Inventário completo de ferramentas do harness', '',
    'Gerado por `node scripts/inventory-harness-tools.mjs --markdown`. Validar alterações com `--check --markdown`.', '',
    `Catálogo próprio: **${report.counts.names} nomes**, incluindo aliases e ferramentas condicionais a papéis. `
      + `**${report.counts.enabled} habilitados em Rust de desenvolvimento; ${report.counts.pending} pendentes de integração nativa.**`, '',
    `Destes, ${report.counts.rootEnabled} pertencem ao catálogo de entrada e ${report.counts.childOnly} são exclusivos de agentes filhos autorizados.`, '',
    'Habilitada não significa certificada em produção. O runtime padrão permanece legado. '
      + 'As pendentes já existem no produto; não são funcionalidades ausentes da instalação atual.', '',
    'Este arquivo mede cobertura de catálogo, não cobertura de testes nem implementação de melhorias. '
      + 'O acompanhamento de melhorias e os limites de validação estão em [tool-improvements.md](./tool-improvements.md).', '',
  ];
  for (const [surface, group] of Object.entries(groups)) {
    lines.push(`## ${surface} (${group.enabled.length + group.contextual.length + group.pending.length})`, '',
      '| Ferramenta | Rust | Definição |', '|---|---|---|');
    for (const name of [...new Set([...group.enabled, ...group.contextual, ...group.pending])].sort()) {
      const sources = definitions.filter(def => def.name === name && def.surface === surface);
      const links = sources.map(def => {
        const link = relative(dirname(markdownPath), resolve(def.file)).replaceAll('\\', '/');
        return `[${def.file}:${def.line}](${link}#L${def.line})`;
      }).join('<br>');
      lines.push(`| \`${name}\` | ${enabled.has(name) ? 'Desenvolvimento' : childEnabled.has(name) ? 'Desenvolvimento (somente filho)' : 'Pendente'} | ${links} |`);
    }
    lines.push('');
  }
  lines.push('## Catálogos dinâmicos', '',
    'MCP externo e plugins dependem do que está conectado e permitido em cada sessão. Seus nomes não cabem numa contagem fixa. '
      + 'O inventário registra as fábricas abaixo sem consultar credenciais ou carregar ferramentas externas.', '',
    '| Superfície | Fábrica | Fonte |', '|---|---|---|');
  for (const item of dynamic) lines.push(`| ${item.surface} | ${item.expression.replaceAll('|', '\\|')} | ${item.file}:${item.line} |`);
  lines.push('', 'A fachada MCP pública já pode encaminhar runs ao runtime selecionado. '
    + 'Isso não habilita automaticamente `mcp__start_agent_run` como ferramenta aninhada de uma árvore Rust.', '');
  return lines.join('\n');
}
if (args.includes('--check')) {
  const existing = JSON.parse(await readFile(output, 'utf8'));
  const stable = ({ checkedAt: _checkedAt, ...value }) => JSON.stringify(value);
  if (stable(existing) !== stable(report)) throw new Error(`Tool inventory is stale: regenerate ${output}`);
  if (args.includes('--markdown') && await readFile(markdownPath, 'utf8') !== markdown()) {
    throw new Error(`Tool inventory Markdown is stale: regenerate ${markdownPath}`);
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  if (args.includes('--markdown')) await writeFile(markdownPath, markdown());
}
console.log(JSON.stringify({ output, filesScanned: seenFiles.length, counts: report.counts,
  ...(args.includes('--verbose') ? { groups, dynamic } : {}),
  tierOnlyNames: report.tierOnlyNames, unresolvedNativeNames: report.unresolvedNativeNames }, null, 2));
if (report.tierOnlyNames.length || report.unresolvedNativeNames.length) process.exitCode = 1;
