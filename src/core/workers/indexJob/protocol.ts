import type { TreeSitterResult } from '../../indexer/tree-sitter/index.js';

export type IndexJobReq =
  | { kind: 'extract'; filePath: string; content: string }
  | { kind: 'hashTree'; pkgDir: string; excludeDirs?: string[] };

export type IndexJobRes =
  | { kind: 'extract'; result: TreeSitterResult }
  | { kind: 'hashTree'; digest: string };
