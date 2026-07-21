import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

export const JS_DEBUG_VERSION = '1.117.0';
export const JS_DEBUG_SHA256 = 'ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772';
export const JS_DEBUG_URL = `https://github.com/microsoft/vscode-js-debug/releases/download/v${JS_DEBUG_VERSION}/js-debug-dap-v${JS_DEBUG_VERSION}.tar.gz`;

const text = (buffer, start, length) => buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');

function confinedPath(root, archivePath) {
  const unix = archivePath.replace(/\\/g, '/');
  if (!unix.startsWith('js-debug/') || unix.includes('../') || unix.startsWith('/')) {
    throw new Error(`unsafe js-debug archive entry: ${archivePath}`);
  }
  const target = resolve(root, ...unix.split('/'));
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '..') throw new Error(`archive entry escapes target: ${archivePath}`);
  return target;
}

/** Minimal regular-file/directory tar extractor with path-confinement. */
export function extractJsDebugTarGz(archive, targetRoot) {
  const tar = gunzipSync(archive);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const sizeText = text(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error(`invalid tar size for ${archivePath}`);
    const type = String.fromCharCode(header[156] || 48);
    const target = confinedPath(targetRoot, archivePath);
    if (type === '5' || archivePath.endsWith('/')) {
      mkdirSync(target, { recursive: true });
    } else if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size));
    } else {
      throw new Error(`unsupported tar entry type '${type}' for ${archivePath}`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

async function downloadVerifiedArchive(cacheFile) {
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile);
    const hash = createHash('sha256').update(cached).digest('hex');
    if (hash === JS_DEBUG_SHA256) return cached;
    rmSync(cacheFile, { force: true });
  }

  const response = await fetch(JS_DEBUG_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`js-debug download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(archive).digest('hex');
  if (hash !== JS_DEBUG_SHA256) {
    throw new Error(`js-debug SHA-256 mismatch: expected ${JS_DEBUG_SHA256}, got ${hash}`);
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, archive);
  return archive;
}

export async function stageJsDebugAdapter(repoRoot, destination) {
  const cacheRoot = join(repoRoot, 'node_modules', '.cache', 'mcp-js-debug', JS_DEBUG_VERSION);
  const archiveFile = join(cacheRoot, `js-debug-dap-v${JS_DEBUG_VERSION}.tar.gz`);
  const extractedRoot = join(cacheRoot, 'extracted');
  const entry = join(extractedRoot, 'js-debug', 'src', 'dapDebugServer.js');
  if (!existsSync(entry)) {
    const archive = await downloadVerifiedArchive(archiveFile);
    const resolvedCache = resolve(cacheRoot);
    const resolvedExtracted = resolve(extractedRoot);
    if (!resolvedExtracted.startsWith(`${resolvedCache}${sep}`)) throw new Error('invalid js-debug cache path');
    rmSync(extractedRoot, { recursive: true, force: true });
    mkdirSync(extractedRoot, { recursive: true });
    extractJsDebugTarGz(archive, extractedRoot);
  }
  if (!existsSync(entry)) throw new Error('js-debug archive did not contain src/dapDebugServer.js');
  mkdirSync(destination, { recursive: true });
  return join(extractedRoot, 'js-debug');
}
