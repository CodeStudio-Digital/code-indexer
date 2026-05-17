export interface Stats {
  file_count: number;
  symbol_count: number;
  total_lines: number;
  total_size: number;
  languages: Record<string, number>;
  last_indexed: string | null;
  run_count: number;
}

export interface DBFile {
  id: number;
  path: string;
  language: string;
  line_count: number;
  summary: string;
  complexity: string;
  layer: string;
  is_entry_point: number;
  is_test: number;
  is_generated: number;
}

export interface Run {
  id: number;
  status: string;
  started_at: string;
  indexed_files: number;
  total_files: number;
  estimated_cost_usd: number;
}

export interface FileDetail extends DBFile {
  concepts: string;
  symbols: Array<{
    id: number;
    name: string;
    kind: string;
    signature: string;
    parent: string | null;
    comment: string | null;
    line: number | null;
    tags: string;
  }>;
  dependencies: Array<{ import_path: string; dep_type: string; target_file_path: string | null }>;
  dependents: Array<{ source_file_path: string; import_path: string }>;
}

export interface Dependency {
  import_path: string;
  dep_type: string;
  target_file_path: string | null;
}
export interface Dependent {
  source_file_path: string;
  import_path: string;
}
export interface CircularDep {
  file_a: string;
  file_b: string;
}

export interface LayerOverview {
  layer: string;
  count: number;
}

export function complexityVariant(c: string): 'destructive' | 'warning' | 'success' {
  if (c === 'high' || c === 'very-high') return 'destructive';
  if (c === 'medium') return 'warning';
  return 'success';
}
