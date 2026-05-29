import type { CodeIndexDB } from '@mcp/store/db.js';
import { detectArchitecturalPatterns } from './architecture-patterns.js';

interface CollectedSymbol {
  path: string;
  name: string;
  kind: string;
  signature: string;
  parent: string | null;
  modifiers: string[];
  comment: string | null;
  extends_from?: string;
  implements_list?: string[];
}

interface CollectedAnalytics {
  languages: Map<string, number>;
  allConcepts: Map<string, number>;
  layers: Map<string, string[]>;
  complexities: Record<string, number>;
  entryPoints: string[];
  testFiles: string[];
  highComplexity: Array<{ path: string; complexity: string }>;
  externalDeps: Set<string>;
  filePaths: Array<{ path: string; lower: string }>;
  allSymbols: CollectedSymbol[];
  totalFiles: number;
}

/**
 * Generate auto-snapshots (architecture overview, patterns, conventions…)
 * over ALL files+symbols currently persisted for the project. Called at the
 * end of `indexProject`. Replaces previously auto-generated snapshots
 * (tagged `auto-generated`) so re-runs stay idempotent.
 */
export async function generateAutoSnapshots(
  db: CodeIndexDB,
  project: { id: number; name: string },
): Promise<void> {
  const allDbFiles = db.listFiles(project.id);
  if (allDbFiles.length === 0) return;

  // Replace previous auto-generated snapshots so this run reflects current state.
  for (const snap of db.listSnapshots(project.id)) {
    try {
      const tags = JSON.parse(snap.tags) as string[];
      if (tags.includes('auto-generated')) db.deleteSnapshot(snap.id);
    } catch { /* ignore */ }
  }

  const analytics = collectAnalytics(db, project, allDbFiles);

  writeArchitectureOverview(db, project, analytics);
  writePatterns(db, project, analytics);
  writeKeyConcepts(db, project, analytics);
  writeClassHierarchy(db, project, analytics);
  writeExternalDeps(db, project, analytics);
  writeHighComplexity(db, project, analytics);
  writePublicApi(db, project, analytics);
  writeConventions(db, project, analytics);
}

function collectAnalytics(
  db: CodeIndexDB,
  project: { id: number; name: string },
  allDbFiles: ReturnType<CodeIndexDB['listFiles']>,
): CollectedAnalytics {
  const languages = new Map<string, number>();
  const allConcepts = new Map<string, number>();
  const layers = new Map<string, string[]>();
  const complexities: Record<string, number> = { low: 0, medium: 0, high: 0, 'very-high': 0 };
  const entryPoints: string[] = [];
  const testFiles: string[] = [];
  const highComplexity: Array<{ path: string; complexity: string }> = [];
  const externalDeps = new Set<string>();
  const filePaths: Array<{ path: string; lower: string }> = [];

  for (const f of allDbFiles) {
    languages.set(f.language, (languages.get(f.language) ?? 0) + 1);
    try {
      const concepts = JSON.parse(f.concepts) as string[];
      for (const c of concepts) allConcepts.set(c, (allConcepts.get(c) ?? 0) + 1);
    } catch { /* ignore */ }

    const layer = f.layer ?? 'unknown';
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer)!.push(f.path);

    if (f.complexity in complexities) complexities[f.complexity]++;
    if (f.complexity === 'high' || f.complexity === 'very-high') {
      highComplexity.push({ path: f.path, complexity: f.complexity });
    }
    if (f.is_entry_point) entryPoints.push(f.path);
    if (f.is_test) testFiles.push(f.path);

    try {
      const extDeps = JSON.parse(f.external_deps) as string[];
      for (const dep of extDeps) externalDeps.add(dep);
    } catch { /* ignore */ }

    filePaths.push({ path: f.path, lower: f.path.toLowerCase() });
  }

  const allSymbols: CollectedSymbol[] = [];
  for (const f of allDbFiles) {
    for (const sym of db.getSymbolsByFile(project.id, f.path)) {
      let mods: string[] = [];
      try { mods = JSON.parse(sym.modifiers) as string[]; } catch { /* ignore */ }
      let extendsFrom: string | undefined;
      let implementsList: string[] | undefined;
      const relations = db.getSymbolRelations(sym.id);
      if (relations) {
        const ext = relations.find((r) => r.relation_type === 'extends');
        if (ext) extendsFrom = ext.related_symbol_name;
        const impls = relations.filter((r) => r.relation_type === 'implements');
        if (impls.length > 0) implementsList = impls.map((i) => i.related_symbol_name);
      }
      allSymbols.push({
        path: f.path, name: sym.name, kind: sym.kind, signature: sym.signature,
        parent: sym.parent, modifiers: mods, comment: sym.comment,
        extends_from: extendsFrom, implements_list: implementsList,
      });
    }
  }

  return {
    languages, allConcepts, layers, complexities, entryPoints, testFiles,
    highComplexity, externalDeps, filePaths, allSymbols, totalFiles: allDbFiles.length,
  };
}

function writeArchitectureOverview(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  const langLines = Array.from(a.languages.entries())
    .sort((x, y) => y[1] - x[1])
    .map(([lang, count]) => `- **${lang}**: ${count} files`).join('\n');
  const layerLines = Array.from(a.layers.entries())
    .sort((x, y) => y[1].length - x[1].length)
    .map(([layer, files]) => `- **${layer}**: ${files.length} files (${files.slice(0, 5).join(', ')}${files.length > 5 ? ` +${files.length - 5} more` : ''})`).join('\n');
  const content = [
    `# Architecture Overview`, ``,
    `**${a.totalFiles} files** indexed across **${a.languages.size} languages**`, ``,
    `## Languages`, langLines, ``,
    `## Layers`, layerLines, ``,
    `## Complexity Distribution`,
    `- Low: ${a.complexities.low} | Medium: ${a.complexities.medium} | High: ${a.complexities.high} | Very-High: ${a.complexities['very-high']}`,
    a.entryPoints.length > 0 ? `\n## Entry Points\n${a.entryPoints.map((p) => `- ${p}`).join('\n')}` : '',
    a.testFiles.length > 0 ? `\n## Test Files\n${a.testFiles.length} test files detected` : '',
  ].filter(Boolean).join('\n');
  db.createSnapshot(project.id, { title: 'Architecture Overview', category: 'architecture', content, tags: ['auto-generated', 'architecture'], createdBy: 'auto', source: 'index' });
}

function writePatterns(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  const patterns = detectArchitecturalPatterns(a.filePaths);
  if (patterns.length === 0) return;
  const content = `# Design Patterns Detected\n\n${patterns.map((p) => `## ${p.name}\n${p.description}\n\nFiles:\n${p.files.map((f) => `- ${f}`).join('\n')}`).join('\n\n')}`;
  db.createSnapshot(project.id, { title: 'Design Patterns', category: 'pattern', content, tags: ['auto-generated', 'patterns'], createdBy: 'auto', source: 'index' });
}

function writeKeyConcepts(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  const top = Array.from(a.allConcepts.entries()).sort((x, y) => y[1] - x[1]).slice(0, 30);
  if (top.length === 0) return;
  const lines = top.map(([concept, count]) => `- **${concept}** (${count} files)`).join('\n');
  db.createSnapshot(project.id, {
    title: 'Key Concepts', category: 'note',
    content: `# Key Concepts\n\nTop concepts found across the codebase:\n\n${lines}`,
    tags: ['auto-generated', 'concepts'], createdBy: 'auto', source: 'index',
  });
}

function writeClassHierarchy(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  const classes = a.allSymbols.filter((s) => s.kind === 'class' || s.kind === 'interface');
  const entries: string[] = [];
  for (const cls of classes) {
    const parts: string[] = [`### ${cls.kind} \`${cls.name}\` — ${cls.path}`];
    if (cls.signature) parts.push(`Signature: \`${cls.signature}\``);
    if (cls.comment) parts.push(cls.comment);
    if (cls.extends_from) parts.push(`Extends: \`${cls.extends_from}\``);
    if (cls.implements_list?.length) parts.push(`Implements: ${cls.implements_list.map((i) => `\`${i}\``).join(', ')}`);
    const members = a.allSymbols.filter((s) => s.parent === cls.name && s.path === cls.path);
    if (members.length > 0) {
      parts.push(`Members (${members.length}):`);
      for (const m of members) parts.push(`- ${m.kind} \`${m.name}\`${m.signature ? `: ${m.signature}` : ''}`);
    }
    entries.push(parts.join('\n'));
  }
  if (entries.length === 0) return;
  db.createSnapshot(project.id, {
    title: 'Classes & Interfaces', category: 'architecture',
    content: `# Classes & Interfaces\n\n${entries.length} classes/interfaces found:\n\n${entries.join('\n\n')}`,
    tags: ['auto-generated', 'hierarchy'], createdBy: 'auto', source: 'index',
  });
}

function writeExternalDeps(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  if (a.externalDeps.size === 0) return;
  const sorted = Array.from(a.externalDeps).sort();
  db.createSnapshot(project.id, {
    title: 'External Dependencies', category: 'note',
    content: `# External Dependencies\n\n${sorted.length} external dependencies detected:\n\n${sorted.map((d) => `- \`${d}\``).join('\n')}`,
    tags: ['auto-generated', 'dependencies'], createdBy: 'auto', source: 'index',
  });
}

function writeHighComplexity(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  if (a.highComplexity.length === 0) return;
  db.createSnapshot(project.id, {
    title: 'High Complexity Files', category: 'todo',
    content: `# High Complexity Files\n\nThese files have high or very-high complexity and may benefit from refactoring:\n\n${a.highComplexity.map((f) => `- **${f.path}** (${f.complexity})`).join('\n')}`,
    tags: ['auto-generated', 'complexity', 'tech-debt'], createdBy: 'auto', source: 'index',
  });
}

function writePublicApi(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  const exported = a.allSymbols.filter((s) =>
    (s.kind === 'function' || s.kind === 'method') &&
    (s.modifiers.includes('export') || s.modifiers.includes('public')) &&
    !s.parent,
  );
  if (exported.length === 0) return;
  const grouped = new Map<string, typeof exported>();
  for (const f of exported) {
    if (!grouped.has(f.path)) grouped.set(f.path, []);
    grouped.get(f.path)!.push(f);
  }
  const apiLines = Array.from(grouped.entries())
    .map(([path, fns]) => `### ${path}\n${fns.map((f) => `- \`${f.signature || f.name}\`${f.comment ? ` — ${f.comment}` : ''}`).join('\n')}`).join('\n\n');
  db.createSnapshot(project.id, {
    title: 'Public API Surface', category: 'convention',
    content: `# Public API Surface\n\nExported functions and entry points:\n\n${apiLines}`,
    tags: ['auto-generated', 'api-surface'], createdBy: 'auto', source: 'index',
  });
}

function writeConventions(db: CodeIndexDB, project: { id: number }, a: CollectedAnalytics): void {
  const conventions: string[] = [];
  const funcNames = a.allSymbols.filter((s) => s.kind === 'function' || s.kind === 'method').map((s) => s.name);
  const camelCount = funcNames.filter((n) => /^[a-z][a-zA-Z0-9]*$/.test(n)).length;
  const snakeCount = funcNames.filter((n) => /^[a-z][a-z0-9_]*$/.test(n) && n.includes('_')).length;
  if (funcNames.length > 3) {
    if (camelCount > snakeCount * 2) conventions.push('- **Naming**: camelCase for functions/methods');
    else if (snakeCount > camelCount * 2) conventions.push('- **Naming**: snake_case for functions/methods');
  }
  const dirStructure = new Map<string, number>();
  for (const f of a.filePaths) {
    const dir = f.path.split('/').slice(0, -1).join('/');
    if (dir) dirStructure.set(dir, (dirStructure.get(dir) ?? 0) + 1);
  }
  const topDirs = Array.from(dirStructure.entries()).sort((x, y) => y[1] - x[1]).slice(0, 10);
  if (topDirs.length > 0) {
    conventions.push(`- **Directory structure**:\n${topDirs.map(([d, c]) => `  - \`${d}/\` (${c} files)`).join('\n')}`);
  }
  if (a.allSymbols.some((s) => s.kind === 'type' || s.kind === 'interface')) {
    conventions.push('- **Types**: Uses explicit type definitions/interfaces');
  }
  if (a.testFiles.length > 0) {
    conventions.push(`- **Testing**: ${a.testFiles.length} test files (${((a.testFiles.length / a.totalFiles) * 100).toFixed(0)}% coverage by file count)`);
  }
  if (conventions.length === 0) return;
  db.createSnapshot(project.id, {
    title: 'Project Conventions', category: 'convention',
    content: `# Project Conventions\n\nDetected conventions and patterns:\n\n${conventions.join('\n')}`,
    tags: ['auto-generated', 'conventions'], createdBy: 'auto', source: 'index',
  });
}
