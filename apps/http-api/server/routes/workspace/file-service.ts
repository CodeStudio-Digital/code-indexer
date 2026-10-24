import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { TREE_BLOCK as DEFAULT_IGNORE } from '@mcp/shared/utils/fs-ignore.js';

interface TreeEntry {
  name: string;
  type: 'file' | 'dir';
  size: number | null;
}

interface FileReadResult {
  content: string;
  encoding: 'utf-8' | 'base64';
  truncated: boolean;
  size: number;
  isBinary: boolean;
}

const MAX_TEXT_BYTES = 1_000_000; // 1 MB — hard cap for file reads

export async function listDir(
  absDir: string,
  opts: { showHidden?: boolean } = {},
): Promise<TreeEntry[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: TreeEntry[] = [];
  for (const e of entries) {
    if (!opts.showHidden && DEFAULT_IGNORE.has(e.name)) continue;
    if (!opts.showHidden && e.name.startsWith('.') && !DEFAULT_IGNORE.has(e.name)) continue;
    if (e.isFile() || e.isDirectory()) {
      let size: number | null = null;
      if (e.isFile()) {
        try {
          const st = await fs.stat(path.join(absDir, e.name));
          size = st.size;
        } catch {
          size = null;
        }
      }
      out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size });
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** Heuristic binary detection: any NUL byte in the first 8 KB = binary. */
function sniffBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < window.length; i++) {
    if (window[i] === 0) return true;
  }
  return false;
}

export async function readText(absFile: string): Promise<FileReadResult> {
  const stat = await fs.stat(absFile);
  const size = stat.size;
  const fh = await fs.open(absFile, 'r');
  try {
    const readBytes = Math.min(size, MAX_TEXT_BYTES);
    const buf = Buffer.alloc(readBytes);
    await fh.read(buf, 0, readBytes, 0);
    const truncated = size > MAX_TEXT_BYTES;
    const isBinary = sniffBinary(buf);
    if (isBinary) {
      return {
        content: buf.toString('base64'),
        encoding: 'base64',
        truncated,
        size,
        isBinary: true,
      };
    }
    return {
      content: buf.toString('utf-8'),
      encoding: 'utf-8',
      truncated,
      size,
      isBinary: false,
    };
  } finally {
    await fh.close();
  }
}
