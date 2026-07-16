import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DBSymbol } from '@mcp/shared/types.js';
import type { VectorItemState } from '@mcp/store/vectors.js';
import {
  buildEmbeddingCandidates,
  type CandidateFile,
  type EmbeddingCandidate,
} from '../indexer/embedding-candidates.js';

const project = { id: 7, name: 'duplicate-symbols' };
const filePath = 'src/duplicates.php';
const fingerprint = 'openrouter:nvidia/llama-nemotron-embed-vl-1b-v2:free';

function dbSymbol(id: number, line: number, endLine: number, signature: string): DBSymbol {
  return {
    id,
    project_id: project.id,
    file_id: 42,
    file_path: filePath,
    name: 'atualiza_registro_geral_catalogo',
    kind: 'function',
    signature,
    parent: null,
    namespace: null,
    modifiers: '[]',
    return_type: null,
    parameters: null,
    line,
    col: 1,
    end_line: endLine,
    exported: 0,
    comment: null,
    tags: '[]',
    created_at: '2026-07-15 00:00:00',
    stable_id: `stable-${id}`,
  };
}

function itemState(candidate: EmbeddingCandidate): VectorItemState {
  return {
    itemKey: `${candidate.metadata.type}:${candidate.metadata.ref_id}`,
    sourceHash: candidate.hash,
    vectorId: candidate.id,
    chunkIndex: Number(candidate.metadata.chunk_index ?? 0),
    status: 'indexed',
    attempts: 1,
    error: null,
  };
}

describe('embedding candidate symbol identity', () => {
  it('keeps homonymous symbols distinct and recognizes the resulting ledger as current', () => {
    const symbols = [
      dbSymbol(10_549, 1, 10, 'function atualiza_registro_geral_catalogo($id)'),
      dbSymbol(10_550, 12, 21, 'function atualiza_registro_geral_catalogo($id){'),
    ];
    const db = {
      getSymbolsByFile: () => symbols,
    } as unknown as CodeIndexDB;
    const content = Array.from({ length: 24 }, (_, index) => `// source line ${index + 1}`).join('\n');
    const files: CandidateFile[] = [{
      path: filePath,
      fileId: 42,
      language: 'php',
      symbols: symbols.map((symbol) => ({
        id: symbol.id,
        stable_id: symbol.stable_id,
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature,
        comment: symbol.comment,
        line: symbol.line,
        end_line: symbol.end_line,
        parent: symbol.parent,
      })),
      content,
    }];

    const candidates = buildEmbeddingCandidates(db, project, files, [], fingerprint);
    const signatures = candidates.filter((candidate) => candidate.metadata.type === 'symbol');
    const bodies = candidates.filter((candidate) => candidate.metadata.type === 'symbol_body');

    expect(signatures.map((candidate) => candidate.metadata.ref_id)).toEqual(['10549', '10550']);
    expect(bodies.map((candidate) => candidate.metadata.ref_id)).toEqual(['10549', '10550']);
    expect(new Set(signatures.map((candidate) => candidate.id)).size).toBe(2);
    expect(new Set(bodies.map((candidate) => candidate.id)).size).toBe(2);

    const legacySignatureId = 's_' + createHash('md5')
      .update(`${project.id}:${filePath}:${symbols[0].name}`)
      .digest('hex').slice(0, 24);
    expect(signatures.every((candidate) => candidate.supersededIds?.includes(legacySignatureId))).toBe(true);

    const legacyBodyId = 'sb_' + createHash('md5')
      .update(`${project.id}:${filePath}:${symbols[0].name}:body`)
      .digest('hex').slice(0, 23);
    const collidedItems = candidates.map((candidate) => {
      const item = itemState(candidate);
      if (candidate.metadata.type === 'symbol') item.vectorId = legacySignatureId;
      if (candidate.metadata.type === 'symbol_body') item.vectorId = legacyBodyId;
      return item;
    });
    const repair = buildEmbeddingCandidates(db, project, files, collidedItems, fingerprint);
    expect(repair.filter((candidate) => candidate.metadata.type === 'symbol')).toHaveLength(2);
    expect(repair.filter((candidate) => candidate.metadata.type === 'symbol_body')).toHaveLength(2);

    const currentItems = candidates.map(itemState);
    expect(buildEmbeddingCandidates(db, project, files, currentItems, fingerprint)).toEqual([]);
  });

  it('preserves the historical vector id for a unique symbol', () => {
    const symbol = {
      ...dbSymbol(10_551, 1, 10, 'function unique_name()'),
      name: 'unique_name',
      stable_id: 'stable-10551',
    };
    const db = { getSymbolsByFile: () => [symbol] } as unknown as CodeIndexDB;
    const files: CandidateFile[] = [{
      path: filePath,
      fileId: 42,
      language: 'php',
      symbols: [{
        id: symbol.id,
        stable_id: symbol.stable_id,
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature,
        line: symbol.line,
        end_line: symbol.end_line,
      }],
      content: Array.from({ length: 12 }, (_, index) => `// source line ${index + 1}`).join('\n'),
    }];

    const signature = buildEmbeddingCandidates(db, project, files, [], fingerprint)
      .find((candidate) => candidate.metadata.type === 'symbol');
    const historicalId = 's_' + createHash('md5')
      .update(`${project.id}:${filePath}:${symbol.name}`)
      .digest('hex').slice(0, 24);

    expect(signature?.id).toBe(historicalId);
    expect(signature?.supersededIds).toBeUndefined();
  });
});
