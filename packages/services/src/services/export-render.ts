import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { DBSymbol, ExportOptions, ExportSection } from '@mcp/shared/types.js';
import { assertExportSize, type ExportData } from './export-source.js';

function cell(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/\r?\n/g, '<br>');
}

export async function renderExport(data: ExportData, options: ExportOptions,
  sections: readonly ExportSection[], signal?: AbortSignal): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0; let work = 0;
  const add = (text: string) => { bytes += Buffer.byteLength(text); assertExportSize(bytes); chunks.push(text); };
  const checkpoint = async () => { if (++work % 256 === 0) await yieldTurn(); signal?.throwIfAborted(); };
  const apiSymbols: DBSymbol[] = []; let invalidTags = 0;
  if (sections.includes('api')) for (const symbol of data.symbols) {
    try {
      const tags: unknown = JSON.parse(symbol.tags);
      if (!Array.isArray(tags)) throw new Error('Invalid tags');
      if (tags.some(tag => ['entry-point', 'handler', 'route', 'middleware', 'api', 'endpoint'].includes(tag))) apiSymbols.push(symbol);
    } catch { invalidTags++; }
    await checkpoint();
  }
  const stats = data.stats ? { file_count: data.stats.file_count, symbol_count: data.stats.symbol_count,
    total_lines: data.stats.total_lines, languages: data.stats.languages,
    structural_indexed_at: data.project?.structural_indexed_at ?? null,
    structural_last_checked_at: data.project?.structural_last_checked_at ?? null } : undefined;
  if (options.format === 'json') {
    add(`{\n  "project": ${JSON.stringify(options.projectName)},\n  "exported_at": ${JSON.stringify(new Date().toISOString())}`);
    if (stats) add(`,\n  "stats": ${JSON.stringify(stats, null, 2)}`);
    const arrays: Array<[string, unknown[]]> = [];
    if (sections.includes('files') || sections.includes('architecture')) arrays.push(['files', data.files]);
    if (sections.includes('symbols')) arrays.push(['symbols', data.symbols]);
    if (sections.includes('api')) arrays.push(['api', apiSymbols]);
    if (sections.includes('snapshots') && options.includeSnapshots) arrays.push(['snapshots', data.snapshots]);
    for (const [key, rows] of arrays) {
      add(`,\n  "${key}": [`);
      for (let i = 0; i < rows.length; i++) { add((i ? ',\n' : '\n') + JSON.stringify(rows[i])); await checkpoint(); }
      add('\n  ]');
    }
    if (invalidTags) add(`,\n  "warnings": [${JSON.stringify(`${invalidTags} symbol(s) had invalid API tags and could not be classified.`)}]`);
    add('\n}');
  } else {
    add(`# ${cell(options.projectName)} - Documentation\n`);
    for (const section of sections) {
      if (section === 'snapshots' && !options.includeSnapshots) continue;
      add('\n---\n\n');
      if (section === 'overview' && stats) {
        add(`## Overview\n\n**Project:** ${cell(options.projectName)}\n`);
        if (data.project?.description) add(`**Description:** ${cell(data.project.description)}\n`);
        add(`**Files:** ${stats.file_count}\n**Symbols:** ${stats.symbol_count}\n**Total Lines:** ${stats.total_lines.toLocaleString()}\n`);
        add(`**Structural Indexed:** ${stats.structural_indexed_at ?? 'Never'}\n**Structural Checked:** ${stats.structural_last_checked_at ?? 'Never'}\n\n`);
        add('### Languages\n\n| Language | Files |\n|----------|-------|\n');
        for (const [language, count] of Object.entries(stats.languages).sort((a, b) => b[1] - a[1])) add(`| ${cell(language)} | ${count} |\n`);
      } else if (section === 'architecture') {
        add('## Architecture\n\n### Directory Structure\n\n');
        let previous = '';
        for (const file of data.files) {
          const parts = file.path.split('/'); const name = parts.pop(); const dir = parts.join('/') || '.';
          if (dir !== previous) { add(`\n**${cell(dir)}/**\n\n`); previous = dir; }
          add(`- ${cell(name)}\n`); await checkpoint();
        }
      } else if (section === 'files') {
        add('## File Index\n\n| Path | Language | Lines | Bytes |\n|------|----------|-------|-------|\n');
        for (const file of data.files) { add(`| ${cell(file.path)} | ${cell(file.language)} | ${file.line_count} | ${file.size} |\n`); await checkpoint(); }
      } else if (section === 'symbols') {
        add('## Symbol Catalog\n');
        const groups = new Map<string, DBSymbol[]>();
        for (const symbol of data.symbols) { const list = groups.get(symbol.kind) ?? []; list.push(symbol); groups.set(symbol.kind, list); await checkpoint(); }
        for (const [kind, symbols] of groups) {
          add(`\n### ${cell(kind)}\n\n| Name | Signature | File | Line |\n|------|-----------|------|------|\n`);
          for (const symbol of symbols) { add(`| ${cell(symbol.name)} | ${cell(symbol.signature)} | ${cell(symbol.file_path)} | ${symbol.line ?? '-'} |\n`); await checkpoint(); }
        }
      } else if (section === 'api') {
        add('## API Map\n\n| Name | Kind | Location | Signature |\n|------|------|----------|-----------|\n');
        for (const symbol of apiSymbols) { add(`| ${cell(symbol.name)} | ${cell(symbol.kind)} | ${cell(symbol.file_path)}:${symbol.line ?? '?'} | ${cell(symbol.signature)} |\n`); await checkpoint(); }
        if (invalidTags) add(`\nWarning: ${invalidTags} symbol(s) had invalid API tags and could not be classified.\n`);
      } else if (section === 'snapshots') {
        add('## Snapshots\n');
        for (const snapshot of data.snapshots) { add(`\n### ${cell(snapshot.title)} (${cell(snapshot.category)})\n\n${snapshot.content}\n`); await checkpoint(); }
      }
      await yieldTurn(); signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  return chunks.join('');
}
