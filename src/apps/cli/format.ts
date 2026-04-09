import type { HybridSearchResult } from '../../types.js';

export function printSearchResults(results: HybridSearchResult[]): void {
  for (const r of results) {
    const d = r.data as unknown as Record<string, unknown>;
    if (r.type === 'file') {
      const concepts = (() => { try { return JSON.parse(d.concepts as string ?? '[]').join(', '); } catch { return ''; } })();
      console.log(`  [file] ${r.score.toFixed(4)} | ${d.path} (${d.language}, ${d.line_count} lines, ${d.complexity})`);
      console.log(`         ${d.summary ?? ''}`);
      if (concepts) console.log(`         Concepts: ${concepts}`);
    } else {
      console.log(`  [symbol] ${r.score.toFixed(4)} | ${d.kind} ${d.name} — ${d.file_path}:${d.line ?? '?'}`);
      console.log(`           ${d.signature ?? ''}`);
      if (d.comment) console.log(`           ${d.comment}`);
    }
  }
}

type UsageCaller = {
  file: string;
  line?: number | null;
  symbols_in_file: string[];
  callers: UsageCaller[];
};

export function printUsageTree(callers: UsageCaller[], indent: string): void {
  for (const c of callers) {
    console.log(`${indent}← ${c.file}${c.line ? `:${c.line}` : ''}`);
    if (c.symbols_in_file.length > 0) {
      console.log(`${indent}  symbols: ${c.symbols_in_file.join(', ')}`);
    }
    if (c.callers.length > 0) {
      printUsageTree(c.callers, indent + '  ');
    }
  }
}
