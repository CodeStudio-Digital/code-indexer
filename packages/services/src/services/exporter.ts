import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ExportOptions, ExportSection, DBFile, DBSymbol } from '@mcp/shared/types.js';
import { SnapshotService } from './snapshots.js';
import { DiffService } from './differ.js';

export class ExportService {
  private snapshotService: SnapshotService;
  private diffService: DiffService;

  constructor(private db: CodeIndexDB) {
    this.snapshotService = new SnapshotService(db);
    this.diffService = new DiffService(db);
  }

  export(options: ExportOptions): string {
    const sections = options.sections.length > 0
      ? options.sections
      : ['overview', 'architecture', 'files', 'symbols', 'concepts', 'api', 'snapshots', 'changelog'] as ExportSection[];

    const builders: Record<ExportSection, () => string> = {
      overview: () => this.buildOverview(options.projectId, options.projectName),
      architecture: () => this.buildArchitecture(options.projectId),
      files: () => this.buildFileIndex(options.projectId),
      symbols: () => this.buildSymbolCatalog(options.projectId),
      concepts: () => this.buildConceptMap(options.projectId),
      api: () => this.buildAPIMap(options.projectId),
      snapshots: () => options.includeSnapshots ? this.buildSnapshots(options.projectId) : '',
      changelog: () => this.buildChangelog(options.projectId),
    };

    const content = sections
      .map(section => builders[section]())
      .filter(Boolean)
      .join('\n\n---\n\n');

    const output = `# ${options.projectName} - Documentation\n\n${content}`;

    if (options.format === 'json') {
      return this.exportAsJson(options, output);
    }

    // Write to file
    const outputPath = options.outputPath ?? join(homedir(), '.mcp-code-indexer', 'exports', `${options.projectName}.md`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, output, 'utf-8');

    return output;
  }

  private buildOverview(projectId: number, projectName: string): string {
    const stats = this.db.getStats(projectId);
    const project = this.db.getProject(projectId);

    const langLines = Object.entries(stats.languages)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `| ${lang} | ${count} |`)
      .join('\n');

    return `## Overview

**Project:** ${projectName}
${project?.description ? `**Description:** ${project.description}` : ''}
**Files:** ${stats.file_count}
**Symbols:** ${stats.symbol_count}
**Total Lines:** ${stats.total_lines.toLocaleString()}
**Last Indexed:** ${stats.last_indexed ?? 'Never'}

### Languages

| Language | Files |
|----------|-------|
${langLines}`;
  }

  private buildArchitecture(projectId: number): string {
    const files = this.db.listFiles(projectId);
    const tree = this.buildDirectoryTree(files);
    const concepts = this.db.listConcepts(projectId).slice(0, 30);

    return `## Architecture

### Directory Structure

\`\`\`
${tree}
\`\`\`

### Key Concepts

${concepts.map(c => `- **${c.concept}** (${c.count} files)`).join('\n')}`;
  }

  private buildFileIndex(projectId: number): string {
    const files = this.db.listFiles(projectId);

    const rows = files.map(f => `| ${f.path} | ${f.language} | ${f.line_count} | ${f.complexity} |`).join('\n');

    return `## File Index

| Path | Language | Lines | Complexity |
|------|----------|-------|------------|
${rows}`;
  }

  private buildSymbolCatalog(projectId: number): string {
    const symbols = this.db.listAllSymbols(projectId);
    const byKind = new Map<string, DBSymbol[]>();

    for (const sym of symbols) {
      const list = byKind.get(sym.kind) ?? [];
      list.push(sym);
      byKind.set(sym.kind, list);
    }

    const sections: string[] = ['## Symbol Catalog\n'];

    for (const [kind, syms] of byKind) {
      sections.push(`### ${kind.charAt(0).toUpperCase() + kind.slice(1)}s\n`);
      sections.push('| Name | Signature | File | Line |');
      sections.push('|------|-----------|------|------|');
      for (const s of syms.slice(0, 100)) {
        sections.push(`| ${s.name} | \`${s.signature.slice(0, 60)}\` | ${s.file_path} | ${s.line ?? '-'} |`);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  private buildConceptMap(projectId: number): string {
    const concepts = this.db.listConcepts(projectId);
    if (concepts.length === 0) return '';

    const lines = concepts.map(c => {
      const files = this.db.getFilesByConcept(projectId, c.concept);
      return `### ${c.concept}\n${files.map(f => `- ${f.path}`).join('\n')}`;
    });

    return `## Concept Map\n\n${lines.join('\n\n')}`;
  }

  private buildAPIMap(projectId: number): string {
    const symbols = this.db.listAllSymbols(projectId);
    const apiSymbols = symbols.filter(s => {
      const tags = JSON.parse(s.tags) as string[];
      return tags.some(t => ['entry-point', 'handler', 'route', 'middleware', 'api', 'endpoint'].includes(t));
    });

    if (apiSymbols.length === 0) return '';

    const rows = apiSymbols.map(s => `| ${s.name} | ${s.kind} | ${s.file_path}:${s.line ?? '?'} | \`${s.signature.slice(0, 50)}\` |`);

    return `## API Map

| Name | Kind | Location | Signature |
|------|------|----------|-----------|
${rows.join('\n')}`;
  }

  private buildSnapshots(projectId: number): string {
    const context = this.snapshotService.getForContext(projectId);
    return context || '';
  }

  private buildChangelog(projectId: number): string {
    const diff = this.diffService.diffLatest(projectId);
    if (!diff) return '';

    return `## Changelog (Latest Run)\n\n${this.diffService.formatDiff(diff)}`;
  }

  private buildDirectoryTree(files: DBFile[]): string {
    const tree = new Map<string, string[]>();

    for (const file of files) {
      const parts = file.path.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';
      const name = parts[parts.length - 1];
      const list = tree.get(dir) ?? [];
      list.push(name);
      tree.set(dir, list);
    }

    const lines: string[] = [];
    const sortedDirs = Array.from(tree.keys()).sort();

    for (const dir of sortedDirs) {
      lines.push(`${dir}/`);
      const dirFiles = tree.get(dir)!;
      for (const f of dirFiles) {
        lines.push(`  ${f}`);
      }
    }

    return lines.join('\n');
  }

  private exportAsJson(options: ExportOptions, markdownContent: string): string {
    const data = {
      project: options.projectName,
      exported_at: new Date().toISOString(),
      stats: this.db.getStats(options.projectId),
      files: this.db.listFiles(options.projectId),
      symbols: this.db.listAllSymbols(options.projectId),
      concepts: this.db.listConcepts(options.projectId),
    };

    const json = JSON.stringify(data, null, 2);
    const outputPath = options.outputPath ?? join(homedir(), '.mcp-code-indexer', 'exports', `${options.projectName}.json`);
    const dir = dirname(outputPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, json, 'utf-8');

    return json;
  }
}
