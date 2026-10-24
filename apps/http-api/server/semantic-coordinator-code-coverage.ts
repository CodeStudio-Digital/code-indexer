import {
buildEmbeddingCandidates,
semanticItemKeysForCandidateFiles,
type CandidateFile
} from '@mcp/indexer/indexer/indexer/embedding-candidates.js';
import {
embeddingFingerprintForGeneration
} from '@mcp/store/vectors.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_VERIFY_WAVE_FILES } from './semantic-coordinator-shared.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async verifyCodeVectorCoverage(this: SemanticCoordinatorContext,
    projectId: number,
    rootPath: string,
    generationId: number,
    namespace: string,
  ): Promise<number> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found during vector verification`);
    const dbFiles = this.deps.db.listFiles(projectId);
    const generationFingerprint = this.deps.semanticStore.getGeneration(generationId)?.fingerprint;
    const fingerprint = generationFingerprint
      ? embeddingFingerprintForGeneration(generationFingerprint)
      : this.deps.codeEmbedding.fingerprint?.() ?? 'embedding:unknown';
    const expectedIdentities = new Set<string>();
    const expectedKeys = new Set<string>();

    for (let offset = 0; offset < dbFiles.length; offset += CODE_VERIFY_WAVE_FILES) {
      const files: CandidateFile[] = [];
      for (const file of dbFiles.slice(offset, offset + CODE_VERIFY_WAVE_FILES)) {
        let content: string;
        try { content = readFileSync(join(rootPath, file.path), 'utf-8'); }
        catch { throw new Error(`vector coverage incomplete: source file disappeared: ${file.path}`); }
        const symbols = this.deps.db.getSymbolsByFile(projectId, file.path);
        files.push({
          path: file.path,
          fileId: file.id,
          language: file.language,
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
        });
      }
      const expected = buildEmbeddingCandidates(
        this.deps.db,
        { id: project.id, name: project.name },
        files,
        [],
        fingerprint,
      );
      const waveItemKeys = semanticItemKeysForCandidateFiles(this.deps.db, projectId, files);
      const waveItems = this.deps.semanticStore.listItems({
        generation_id: generationId,
        namespace,
        item_keys: waveItemKeys,
      });
      const actual = new Map<string, (typeof waveItems)[number]>();
      for (const item of waveItems) {
        const identity = `${item.item_key}\0${item.chunk_index}`;
        if (actual.has(identity)) throw new Error(`vector coverage incomplete: duplicate item ${item.item_key}`);
        actual.set(identity, item);
      }
      for (const candidate of expected) {
        const itemKey = `${candidate.metadata.type ?? 'vector'}:${candidate.metadata.ref_id ?? candidate.id}`;
        const chunkIndex = Number(candidate.metadata.chunk_index ?? 0) || 0;
        const identity = `${itemKey}\0${chunkIndex}`;
        const item = actual.get(identity);
        if (!item
          || item.status !== 'indexed'
          || item.vector_id !== candidate.id
          || item.source_hash !== candidate.hash) {
          throw new Error(`vector coverage incomplete: ${itemKey}#${chunkIndex} is not current`);
        }
        expectedIdentities.add(identity);
        expectedKeys.add(itemKey);
      }
    }

    let items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    const obsoleteKeys = [...new Set(items
      .filter((item) => !expectedKeys.has(item.item_key))
      .map((item) => item.item_key))];
    if (obsoleteKeys.length > 0) {
      await this.workerDeleteItemKeys(namespace, generationId, obsoleteKeys);
    }
    const obsoleteIds = items.flatMap((item) =>
      item.vector_id && expectedKeys.has(item.item_key)
        && !expectedIdentities.has(`${item.item_key}\0${item.chunk_index}`)
        ? [item.vector_id]
        : []);
    if (obsoleteIds.length > 0) {
      await this.workerDeleteIds(namespace, generationId, obsoleteIds);
      try { await this.deps.lshSink.afterDelete?.(projectId, obsoleteIds); }
      catch { /* LSH cleanup is best-effort. */ }
    }
    if (obsoleteKeys.length > 0 || obsoleteIds.length > 0) {
      items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    }
    const actual = new Set<string>();
    for (const item of items) {
      const key = `${item.item_key}\0${item.chunk_index}`;
      if (actual.has(key)) throw new Error(`vector coverage incomplete: duplicate item ${item.item_key}`);
      if (item.status !== 'indexed' || !item.vector_id) {
        throw new Error(`vector coverage incomplete: ${item.item_key}#${item.chunk_index} is not indexed`);
      }
      actual.add(key);
    }
    if (actual.size !== expectedIdentities.size
      || [...expectedIdentities].some((identity) => !actual.has(identity))) {
      throw new Error(`vector coverage incomplete: found ${actual.size}/${expectedIdentities.size} exact code items`);
    }
    await this.verifyPhysicalVectorIds(
      namespace,
      generationId,
      items.flatMap((item) => item.vector_id ? [item.vector_id] : []),
    );
    return expectedIdentities.size;
  }
};
