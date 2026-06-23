/** Shared shapes for the Find/Replace-in-files panel (mirror api-bus search). */
export interface GMatch {
  line: number; // 1-based
  text: string;
  start: number;
  end: number;
}
export interface GFile {
  path: string;
  matches: GMatch[];
}
export interface GResult {
  files: GFile[];
  total: number;
  fileCount: number;
  truncated: boolean;
}

export interface FindOpts {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs, e.g. `*.tsx, *.ts`. */
  mask: string;
}

export interface Selected {
  path: string;
  line: number;
}
