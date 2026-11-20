import { itemsByKey, hasCurrentItems } from './embedding-item-state.js';
export { semanticItemKeysForCandidateFiles, semanticItemKeysForIndexedPaths } from './embedding-item-state.js';
import type { CandidateSymbol, CandidateFile, EmbeddingCandidate, SkippedSymbolGroup } from './embedding-candidate-types.js';
export type { CandidateSymbol, CandidateFile, EmbeddingCandidate } from './embedding-candidate-types.js';
import { createHash } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorItemState } from '@mcp/store/vectors.js';
import { codeBodyTexts } from './code-body-windows.js';

const MIN_BODY_LINES = Number(process.env.MCP_INDEX_BODY_MIN_LINES ?? 8);
const MAX_BODY_CHARS = Number(process.env.MCP_INDEX_BODY_MAX_CHARS ?? 2500);
// Bodies over MAX_BODY_CHARS are split into overlapping windows instead of
// being truncated, so the tail of large functions stays searchable.
const BODY_OVERLAP_CHARS = Number(process.env.MCP_INDEX_BODY_OVERLAP_CHARS ?? 250);
const MAX_BODY_CHUNKS = Number(process.env.MCP_INDEX_BODY_MAX_CHUNKS ?? 4);
const SIBLING_GAP = 3;
const GROUP_MIN_LINES = 3;

/**
 * Build embedding candidates directly from structural facts and source
 * content. Shared by generation backfills and watcher/editor deltas.
 *
 * Skips files whose semantic_items hash matches the recomputed text — an
 * incremental run only re-embeds what changed in its target generation.
 */
export function buildEmbeddingCandidates(
  db: CodeIndexDB,
  project: { id: number; name: string },
  files: CandidateFile[],
  currentItems: readonly VectorItemState[] = [],
  embeddingFingerprint = 'embedding:unknown',
): EmbeddingCandidate[] {
  const candidates: EmbeddingCandidate[] = [];
  const currentByKey = itemsByKey(currentItems);

  for (const file of files) {
    appendFileCandidate(candidates, project, file, currentByKey, embeddingFingerprint);
    appendSymbolCandidates(candidates, db, project, file, currentByKey, embeddingFingerprint);
  }

  return candidates;
}

function appendFileCandidate(
  candidates: EmbeddingCandidate[],
  project: { id: number; name: string },
  file: CandidateFile,
  currentByKey: ReadonlyMap<string, readonly VectorItemState[]>,
  embeddingFingerprint: string,
): void {
  const skeleton = file.symbols
    .slice(0, 48)
    .map((symbol) => [
      `${symbol.kind} ${symbol.name}`,
      symbol.signature?.trim(),
      symbol.comment?.trim(),
    ].filter(Boolean).join(' — '))
    .join('\n');
  const sourcePreview = file.content.trim().slice(0, 1_600);
  const fileText = [
    `File: ${file.path}`,
    `Language: ${file.language}`,
    skeleton ? `Structural skeleton:\n${skeleton}` : '',
    sourcePreview ? `Source preview:\n${sourcePreview}` : '',
  ].filter(Boolean).join('\n').slice(0, 4_000);

  const fileHash = createHash('md5').update(`${embeddingFingerprint}\n${fileText}`).digest('hex');
  const fileVecId = 'f_' + createHash('md5').update(`${project.id}:${file.path}`).digest('hex').slice(0, 24);

  if (!hasCurrentItems(currentByKey, `file:${file.fileId}`, fileHash, 1, [fileVecId])) {
    candidates.push({
      text: fileText,
      id: fileVecId,
      filePath: file.path,
      metadata: { project_name: project.name, type: 'file', ref_id: String(file.fileId) },
      hash: fileHash,
      embeddingFingerprint,
      hashForFingerprint: (fingerprint) =>
        createHash('md5').update(`${fingerprint}\n${fileText}`).digest('hex'),
      onCommit: () => { /* semantic_items is committed by the vector worker */ },
    });
  }
}

function appendSymbolCandidates(
  candidates: EmbeddingCandidate[],
  db: CodeIndexDB,
  project: { id: number; name: string },
  file: CandidateFile,
  currentByKey: ReadonlyMap<string, readonly VectorItemState[]>,
  embeddingFingerprint: string,
): void {
  const dbSymbols = db.getSymbolsByFile(project.id, file.path);
  const usedDbIds = new Set<number>();

  const sortedSymbols = [...file.symbols]
    .filter((s) => ['class', 'function', 'interface', 'method'].includes(s.kind))
    .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
  const nameCounts = new Map<string, number>();
  for (const symbol of sortedSymbols) nameCounts.set(symbol.name, (nameCounts.get(symbol.name) ?? 0) + 1);
  const duplicateNames = new Set(
    [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );

  const fileLines = file.content.split(/\r?\n/);
  const skippedSymbols: SkippedSymbolGroup[] = [];

  const globalContext = [
    `File: ${file.path}`,
    `Language: ${file.language}`,
    file.symbols.length
      ? `Skeleton: ${file.symbols.slice(0, 32).map((symbol) => [
          `${symbol.kind} ${symbol.name}`,
          symbol.signature?.trim(),
          symbol.comment?.trim(),
        ].filter(Boolean).join(' — ')).join(' | ')}`
      : '',
  ].filter(Boolean).join(' | ').slice(0, 1_600);

  for (let i = 0; i < sortedSymbols.length; i++) {
    const sym = sortedSymbols[i];
    const symDbId = resolveSymbolDbId(sym, dbSymbols, usedDbIds);
    if (!symDbId) continue;
    const vectorIdentity = duplicateNames.has(sym.name) ? `${sym.name}:${symDbId}` : sym.name;

    appendSigCandidate(
      candidates,
      project,
      file.path,
      sym,
      symDbId,
      vectorIdentity,
      globalContext,
      currentByKey,
      embeddingFingerprint,
    );

    if (sym.line === null || sym.line === undefined) continue;

    const lineStart = Math.max(0, sym.line - 1);
    const symEndLine = sym.end_line;
    let lineEnd: number;
    if (symEndLine) {
      lineEnd = Math.min(fileLines.length, symEndLine);
    } else {
      const nextSym = sortedSymbols[i + 1];
      const nextLine = nextSym?.line ?? fileLines.length + 1;
      lineEnd = Math.min(fileLines.length, nextLine - 1);
    }
    const spanLines = lineEnd - lineStart;
    if (spanLines < MIN_BODY_LINES) {
      skippedSymbols.push({ sym, symDbId, lineStart, lineEnd });
      continue;
    }

    appendBodyCandidate(
      candidates,
      project,
      file.path,
      sym,
      symDbId,
      vectorIdentity,
      globalContext,
      fileLines,
      lineStart,
      lineEnd,
      currentByKey,
      embeddingFingerprint,
    );
  }

  // cAST Sibling Merging — group small adjacent siblings into one body chunk.
  if (skippedSymbols.length > 0) {
    mergeSiblings(
      candidates,
      project,
      file.path,
      skippedSymbols,
      duplicateNames,
      fileLines,
      globalContext,
      currentByKey,
      embeddingFingerprint,
    );
  }
}

/** Candidate symbols normally come directly from the structural rows. The
 * scored fallback keeps older callers/tests deterministic without ever
 * collapsing two homonyms onto the same database id. */
function resolveSymbolDbId(
  symbol: CandidateSymbol,
  dbSymbols: ReturnType<CodeIndexDB['getSymbolsByFile']>,
  usedDbIds: Set<number>,
): number | undefined {
  if (symbol.id !== undefined) {
    const exact = dbSymbols.find((candidate) => candidate.id === symbol.id);
    if (exact) {
      usedDbIds.add(exact.id);
      return exact.id;
    }
  }

  const available = dbSymbols.filter((candidate) =>
    !usedDbIds.has(candidate.id)
    && candidate.kind === symbol.kind
    && candidate.name === symbol.name,
  );
  const exactStable = symbol.stable_id
    ? available.find((candidate) => candidate.stable_id === symbol.stable_id)
    : undefined;
  const exactLocation = available.find((candidate) =>
    candidate.line === (symbol.line ?? null)
    && candidate.end_line === (symbol.end_line ?? null)
    && candidate.signature === (symbol.signature ?? ''),
  );
  const exactLine = available.find((candidate) => candidate.line === (symbol.line ?? null));
  const resolved = exactStable ?? exactLocation ?? exactLine ?? available[0];
  if (resolved) usedDbIds.add(resolved.id);
  return resolved?.id;
}

function appendSigCandidate(
  candidates: EmbeddingCandidate[],
  project: { id: number; name: string },
  filePath: string,
  sym: CandidateSymbol,
  symDbId: number,
  vectorIdentity: string,
  globalContext: string,
  currentByKey: ReadonlyMap<string, readonly VectorItemState[]>,
  embeddingFingerprint: string,
): void {
  const sigText = [
    `[Context: ${globalContext}]`,
    `${sym.kind}: ${sym.name}`,
    sym.signature ? `Signature: ${sym.signature}` : '',
    sym.comment ? `Description: ${sym.comment}` : '',
  ].filter(Boolean).join('\n').slice(0, 1000);

  const sigHash = createHash('md5').update(`${embeddingFingerprint}\n${sigText}`).digest('hex');
  const symVecId = 's_' + createHash('md5').update(`${project.id}:${filePath}:${vectorIdentity}`).digest('hex').slice(0, 24);
  const legacySymVecId = vectorIdentity === sym.name
    ? undefined
    : 's_' + createHash('md5')
      .update(`${project.id}:${filePath}:${sym.name}`)
      .digest('hex').slice(0, 24);

  if (!hasCurrentItems(currentByKey, `symbol:${symDbId}`, sigHash, 1, [symVecId])) {
    candidates.push({
      text: sigText,
      id: symVecId,
      filePath,
      metadata: { project_name: project.name, type: 'symbol', ref_id: String(symDbId) },
      hash: sigHash,
      embeddingFingerprint,
      hashForFingerprint: (fingerprint) =>
        createHash('md5').update(`${fingerprint}\n${sigText}`).digest('hex'),
      ...(legacySymVecId ? { supersededIds: [legacySymVecId] } : {}),
      onCommit: () => { /* semantic_items is committed by the vector worker */ },
    });
  }
}

function appendBodyCandidate(
  candidates: EmbeddingCandidate[],
  project: { id: number; name: string },
  filePath: string,
  sym: CandidateSymbol,
  symDbId: number,
  vectorIdentity: string,
  globalContext: string,
  fileLines: string[],
  lineStart: number,
  lineEnd: number,
  currentByKey: ReadonlyMap<string, readonly VectorItemState[]>,
  embeddingFingerprint: string,
): void {
  const fullBody = fileLines.slice(lineStart, lineEnd).join('\n');
  const header = `[Context: ${globalContext}]\n${sym.kind} ${sym.name}\n${sym.signature ?? ''}\n---\n`;
  const chunkTexts = codeBodyTexts(fullBody, header, {
    windowChars: MAX_BODY_CHARS,
    overlapChars: BODY_OVERLAP_CHARS,
    maxChunks: MAX_BODY_CHUNKS,
  });

  // One combined hash gates the whole body: any window change re-emits all
  // windows. It lives in the symbol's single body-hash slot.
  const combinedHash = createHash('md5')
    .update(`${embeddingFingerprint}\n${chunkTexts.join('\0')}`)
    .digest('hex');

  // Only the LAST window carries the real hash commit (others are no-ops).
  // Candidates are pushed contiguously and batch slicers keep a groupKey
  // together, so the commit only runs once its whole group upserted. If a
  // batch fails, the hash is never written and every window re-emits on the
  // next run (self-healing). With the old all-windows commit, a failure
  // after the first batch persisted the hash while windows were missing
  // from the store, and the incremental check then trusted that gap forever.
  const groupKey = `body:${symDbId}`;
  const bodyChunkId = (i: number): string => {
    // Chunk 0 keeps the historical id (no suffix) so it overwrites the old
    // single vector in place — no mass re-orphaning on the first reindex.
    const idSeed = i === 0
      ? `${project.id}:${filePath}:${vectorIdentity}:body`
      : `${project.id}:${filePath}:${vectorIdentity}:body:${i}`;
    return 'sb_' + createHash('md5').update(idSeed).digest('hex').slice(0, 23);
  };
  const expectedVectorIds = chunkTexts.map((_, index) => bodyChunkId(index));
  if (hasCurrentItems(
    currentByKey,
    `symbol_body:${symDbId}`,
    combinedHash,
    chunkTexts.length,
    expectedVectorIds,
  )) return;
  // Ids of windows this body USED to have but no longer does (deterministic
  // up to the configured max). Carried on the last chunk so the executor
  // cleans them after the new windows landed.
  const supersededIds: string[] = [];
  for (let j = chunkTexts.length; j < MAX_BODY_CHUNKS; j++) supersededIds.push(bodyChunkId(j));
  if (vectorIdentity !== sym.name) {
    for (let j = 0; j < MAX_BODY_CHUNKS; j++) {
      const legacySeed = j === 0
        ? `${project.id}:${filePath}:${sym.name}:body`
        : `${project.id}:${filePath}:${sym.name}:body:${j}`;
      supersededIds.push('sb_' + createHash('md5').update(legacySeed).digest('hex').slice(0, 23));
    }
  }

  chunkTexts.forEach((text, i) => {
    const isLast = i === chunkTexts.length - 1;
    candidates.push({
      text,
      id: bodyChunkId(i),
      filePath,
      metadata: {
        project_name: project.name,
        type: 'symbol_body',
        ref_id: String(symDbId),
        chunk_index: String(i),
      },
      hash: combinedHash,
      embeddingFingerprint,
      hashForFingerprint: (fingerprint) => createHash('md5')
        .update(`${fingerprint}\n${chunkTexts.join('\0')}`)
        .digest('hex'),
      groupKey,
      ...(isLast && supersededIds.length > 0 ? { supersededIds } : {}),
      onCommit: isLast
        ? () => { /* semantic_items is committed by the vector worker */ }
        : () => { /* committed by the last window of the group */ },
    });
  });
}

function mergeSiblings(
  candidates: EmbeddingCandidate[],
  project: { id: number; name: string },
  filePath: string,
  skippedSymbols: SkippedSymbolGroup[],
  duplicateNames: ReadonlySet<string>,
  fileLines: string[],
  globalContext: string,
  currentByKey: ReadonlyMap<string, readonly VectorItemState[]>,
  embeddingFingerprint: string,
): void {
  skippedSymbols.sort((a, b) => a.lineStart - b.lineStart);
  let currentGroup: SkippedSymbolGroup[] = [];
  let groupChars = 0;

  const flush = () => {
    if (currentGroup.length === 0) return;
    const first = currentGroup[0];
    const last = currentGroup[currentGroup.length - 1];
    const totalLines = last.lineEnd - first.lineStart;
    if (totalLines < GROUP_MIN_LINES) return;

    const bodyParts = currentGroup.map((item) => {
      const slice = fileLines.slice(item.lineStart, item.lineEnd).join('\n');
      return `method ${item.sym.name}: ${item.sym.signature ?? '()'}\n---\n${slice}`;
    });
    const bodyText = `[Context: ${globalContext}]\n[group] File: ${filePath} (parent: ${first.sym.parent ?? 'None'})\n\n${bodyParts.join('\n\n')}`;
    const bodyHash = createHash('md5').update(`${embeddingFingerprint}\n${bodyText}`).digest('hex');
    const legacySeed = `${project.id}:${filePath}:${first.sym.name}:${last.sym.name}`;
    const groupIdentity = duplicateNames.has(first.sym.name) || duplicateNames.has(last.sym.name)
      ? `${legacySeed}:${first.symDbId}:${last.symDbId}`
      : legacySeed;
    const sgVecId = 'sg_' + createHash('md5')
      .update(groupIdentity)
      .digest('hex').slice(0, 22);
    const anchorSymDbId = first.symDbId;
    if (hasCurrentItems(currentByKey, `symbol_group:${anchorSymDbId}`, bodyHash, 1, [sgVecId])) return;
    const legacySgVecId = groupIdentity === legacySeed
      ? undefined
      : 'sg_' + createHash('md5').update(legacySeed).digest('hex').slice(0, 22);

    candidates.push({
      text: bodyText.slice(0, MAX_BODY_CHARS),
      id: sgVecId,
      filePath,
      metadata: { project_name: project.name, type: 'symbol_group', ref_id: String(anchorSymDbId) },
      hash: bodyHash,
      embeddingFingerprint,
      hashForFingerprint: (fingerprint) =>
        createHash('md5').update(`${fingerprint}\n${bodyText}`).digest('hex'),
      ...(legacySgVecId ? { supersededIds: [legacySgVecId] } : {}),
      onCommit: () => { /* semantic_items is committed by the vector worker */ },
    });
  };

  for (const item of skippedSymbols) {
    if (currentGroup.length === 0) {
      currentGroup.push(item);
      groupChars += (item.lineEnd - item.lineStart) * 50;
      continue;
    }
    const prev = currentGroup[currentGroup.length - 1];
    const gap = item.lineStart - prev.lineEnd;
    const sameParent = item.sym.parent === prev.sym.parent;
    if (gap <= SIBLING_GAP && sameParent && groupChars < MAX_BODY_CHARS) {
      currentGroup.push(item);
      groupChars += (item.lineEnd - item.lineStart) * 50;
    } else {
      flush();
      currentGroup = [item];
      groupChars = (item.lineEnd - item.lineStart) * 50;
    }
  }
  flush();
}
