import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { glob } from 'glob';
import ignore from 'ignore';
import type { CodeIndexDB } from '../../store/db.js';
import type { ScannedFile, ScanResult } from '../../types.js';
import { applyGraphPromotion, classifyPath, isHardExcluded, type FileIndexTier } from './mapper.js';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib',
  '.pyc', '.pyo', '.class', '.jar', '.war',
  '.sqlite', '.db', '.sqlite3',
  '.lock',
]);

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.cache',
  '.vscode',
  '.idea',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
];

export class FileScanner {
  private rootPath: string;
  private ig: ReturnType<typeof ignore>;
  private maxFileSizeBytes: number;

  constructor(rootPath: string, ignorePatterns: string[] = [], maxFileSizeKB: number = 200) {
    this.rootPath = resolve(rootPath);
    this.maxFileSizeBytes = maxFileSizeKB * 1024;

    this.ig = ignore();
    this.ig.add(DEFAULT_IGNORE_PATTERNS);
    this.ig.add(ignorePatterns);

    // Load .gitignore if present
    const gitignorePath = join(this.rootPath, '.gitignore');
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
      this.ig.add(gitignoreContent);
    }

    // Load .mcpindexignore if present (project-specific ignore rules)
    const mcpIgnorePath = join(this.rootPath, '.mcpindexignore');
    if (existsSync(mcpIgnorePath)) {
      const mcpIgnoreContent = readFileSync(mcpIgnorePath, 'utf-8');
      this.ig.add(mcpIgnoreContent);
    }
  }

  async scan(db: CodeIndexDB, projectId: number): Promise<ScanResult> {
    // Find all files
    const allFiles = await glob('**/*', {
      cwd: this.rootPath,
      nodir: true,
      dot: false,
      absolute: false,
    });

    // Filter by ignore rules, binary extensions, and the auto-mapper's
    // hard-exclude list. Mapper exclusions cover common cases that
    // gitignore tends to miss in monorepos (vendored bundles, .min.js,
    // .tsbuildinfo, lockfiles checked in by accident).
    const validFiles = allFiles.filter(relPath => {
      const ext = this.getExtension(relPath);
      if (BINARY_EXTENSIONS.has(ext)) return false;
      if (this.ig.ignores(relPath)) return false;
      if (isHardExcluded(relPath)) return false;
      return true;
    });

    // Get existing files from DB
    const existingFiles = db.listFiles(projectId);
    const existingMap = new Map(existingFiles.map(f => [f.path, f.content_hash]));
    // In-degree from prior indexing — drives mapper promotion. Empty on
    // first run; refined on every subsequent reindex.
    const indegrees = db.getFileIndegrees(projectId);

    const toIndex: ScannedFile[] = [];
    const unchanged: string[] = [];

    for (const relPath of validFiles) {
      const absPath = join(this.rootPath, relPath);
      const normalizedPath = relPath.replace(/\\/g, '/');

      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        continue; // Skip files that can't be read
      }

      const sizeBytes = Buffer.byteLength(content, 'utf-8');
      if (sizeBytes > this.maxFileSizeBytes) continue;

      const hash = FileScanner.hashContent(content);
      const existingHash = existingMap.get(normalizedPath);

      if (existingHash === hash) {
        unchanged.push(normalizedPath);
      } else {
        const classification = classifyPath(normalizedPath, sizeBytes);
        // `classifyPath` may demote a file to `excluded` based on size or
        // path tokens that the cheap `isHardExcluded` upstream missed
        // (e.g. files that needed to be read to know their size).
        if (classification.tier === 'excluded') continue;
        const indegree = indegrees.get(normalizedPath);
        const promotedTier = applyGraphPromotion(classification.tier, indegree);
        const reason =
          promotedTier !== classification.tier
            ? `${classification.reason} + graph promotion (indegree=${indegree})`
            : classification.reason;
        toIndex.push({
          path: absPath,
          relativePath: normalizedPath,
          content,
          hash,
          sizeBytes,
          lineCount: FileScanner.countLines(content),
          tier: promotedTier as Exclude<FileIndexTier, 'excluded'>,
          mapperReason: reason,
        });
      }

      existingMap.delete(normalizedPath);
    }

    // Remaining entries in existingMap are files to remove
    const toRemove = Array.from(existingMap.keys());

    return { toIndex, unchanged, toRemove };
  }

  static hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  static countLines(content: string): number {
    return content.split('\n').length;
  }

  private getExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return '';
    return filePath.slice(lastDot).toLowerCase();
  }
}
