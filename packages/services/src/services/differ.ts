import type { CodeIndexDB } from '@mcp/store/db.js';
import type { RunDiff, DiffFileEntry, DiffFileModified, DiffSymbolEntry, FileSnapshot, LLMSymbol, SymbolKind } from '@mcp/shared/types.js';

export class DiffService {
  constructor(private db: CodeIndexDB) {}

  diff(projectId: number, runBefore: number, runAfter: number): RunDiff {
    const snapshotsBefore = this.db.getFileSnapshots(runBefore);
    const snapshotsAfter = this.db.getFileSnapshots(runAfter);

    const beforeMap = new Map(snapshotsBefore.map(s => [s.file_path, s]));
    const afterMap = new Map(snapshotsAfter.map(s => [s.file_path, s]));

    const filesAdded: DiffFileEntry[] = [];
    const filesRemoved: DiffFileEntry[] = [];
    const filesModified: DiffFileModified[] = [];
    let totalSymbolsAdded = 0;
    let totalSymbolsRemoved = 0;
    const allConceptsAdded = new Set<string>();
    const allConceptsRemoved = new Set<string>();

    // Files in after but not in before = added
    for (const [path, snap] of afterMap) {
      if (!beforeMap.has(path)) {
        filesAdded.push({
          path,
          language: this.guessLangFromPath(path),
          summary: snap.summary,
        });
        const syms = this.parseSymbols(snap.symbols);
        totalSymbolsAdded += syms.length;
        const concepts = JSON.parse(snap.concepts) as string[];
        concepts.forEach(c => allConceptsAdded.add(c));
      }
    }

    // Files in before but not in after = removed
    for (const [path, snap] of beforeMap) {
      if (!afterMap.has(path)) {
        filesRemoved.push({
          path,
          language: this.guessLangFromPath(path),
          summary: snap.summary,
        });
        const syms = this.parseSymbols(snap.symbols);
        totalSymbolsRemoved += syms.length;
        const concepts = JSON.parse(snap.concepts) as string[];
        concepts.forEach(c => allConceptsRemoved.add(c));
      }
    }

    // Files in both with different hashes = modified
    for (const [path, afterSnap] of afterMap) {
      const beforeSnap = beforeMap.get(path);
      if (beforeSnap && beforeSnap.content_hash !== afterSnap.content_hash) {
        const symsBefore = this.parseSymbols(beforeSnap.symbols);
        const symsAfter = this.parseSymbols(afterSnap.symbols);
        const conceptsBefore = new Set(JSON.parse(beforeSnap.concepts) as string[]);
        const conceptsAfter = new Set(JSON.parse(afterSnap.concepts) as string[]);

        const beforeNames = new Set(symsBefore.map(s => `${s.kind}:${s.name}`));
        const afterNames = new Set(symsAfter.map(s => `${s.kind}:${s.name}`));

        const symbolsAdded: DiffSymbolEntry[] = symsAfter
          .filter(s => !beforeNames.has(`${s.kind}:${s.name}`))
          .map(s => ({ name: s.name, kind: s.kind, signature: s.signature }));

        const symbolsRem: DiffSymbolEntry[] = symsBefore
          .filter(s => !afterNames.has(`${s.kind}:${s.name}`))
          .map(s => ({ name: s.name, kind: s.kind, signature: s.signature }));

        const conAdded = Array.from(conceptsAfter).filter(c => !conceptsBefore.has(c));
        const conRemoved = Array.from(conceptsBefore).filter(c => !conceptsAfter.has(c));

        totalSymbolsAdded += symbolsAdded.length;
        totalSymbolsRemoved += symbolsRem.length;
        conAdded.forEach(c => allConceptsAdded.add(c));
        conRemoved.forEach(c => allConceptsRemoved.add(c));

        filesModified.push({
          path,
          language: this.guessLangFromPath(path),
          summary_before: beforeSnap.summary,
          summary_after: afterSnap.summary,
          symbols_added: symbolsAdded,
          symbols_removed: symbolsRem,
          concepts_added: conAdded,
          concepts_removed: conRemoved,
        });
      }
    }

    return {
      project_id: projectId,
      run_before: runBefore,
      run_after: runAfter,
      files_added: filesAdded,
      files_removed: filesRemoved,
      files_modified: filesModified,
      total_symbols_added: totalSymbolsAdded,
      total_symbols_removed: totalSymbolsRemoved,
      concepts_added: Array.from(allConceptsAdded),
      concepts_removed: Array.from(allConceptsRemoved),
    };
  }

  diffLatest(projectId: number): RunDiff | null {
    const runIds = this.db.getLastTwoRunIds(projectId);
    if (!runIds) return null;
    return this.diff(projectId, runIds[0], runIds[1]);
  }

  formatDiff(diff: RunDiff): string {
    const lines: string[] = [];

    lines.push(`**Added:** ${diff.files_added.length} files | **Removed:** ${diff.files_removed.length} files | **Modified:** ${diff.files_modified.length} files`);
    lines.push(`**Symbols:** +${diff.total_symbols_added} / -${diff.total_symbols_removed}`);

    if (diff.files_added.length > 0) {
      lines.push('\n### Added Files');
      for (const f of diff.files_added) {
        lines.push(`- \`${f.path}\` (${f.language}) — ${f.summary}`);
      }
    }

    if (diff.files_removed.length > 0) {
      lines.push('\n### Removed Files');
      for (const f of diff.files_removed) {
        lines.push(`- \`${f.path}\` (${f.language}) — ${f.summary}`);
      }
    }

    if (diff.files_modified.length > 0) {
      lines.push('\n### Modified Files');
      for (const f of diff.files_modified) {
        lines.push(`- \`${f.path}\``);
        if (f.symbols_added.length > 0) {
          lines.push(`  + Symbols added: ${f.symbols_added.map(s => s.name).join(', ')}`);
        }
        if (f.symbols_removed.length > 0) {
          lines.push(`  - Symbols removed: ${f.symbols_removed.map(s => s.name).join(', ')}`);
        }
      }
    }

    if (diff.concepts_added.length > 0) {
      lines.push(`\n### New Concepts: ${diff.concepts_added.join(', ')}`);
    }
    if (diff.concepts_removed.length > 0) {
      lines.push(`### Removed Concepts: ${diff.concepts_removed.join(', ')}`);
    }

    return lines.join('\n');
  }

  private parseSymbols(json: string): DiffSymbolEntry[] {
    try {
      return JSON.parse(json) as DiffSymbolEntry[];
    } catch {
      return [];
    }
  }

  private guessLangFromPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'TypeScript', js: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust',
      java: 'Java', rb: 'Ruby', php: 'PHP', cs: 'C#', cpp: 'C++', c: 'C',
    };
    return map[ext] ?? 'unknown';
  }
}
