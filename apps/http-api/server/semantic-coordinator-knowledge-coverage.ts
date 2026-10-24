import {
agentMemoryEmbeddingTextHash,
agentMemoryEmbeddingTexts
} from '@mcp/services/memory/agent-memory-service.js';
import {
investigationEmbeddingTextHash
} from '@mcp/services/memory/investigation-semantic-index.js';
import {
snapshotEmbeddingTextHash,
snapshotEmbeddingTexts
} from '@mcp/services/services/snapshots.js';
import {
embeddingFingerprintForGeneration
} from '@mcp/store/vectors.js';

import type { SemanticCoordinatorContext } from './semantic-coordinator-context.js';

export const operations = {
async verifySnapshotVectorCoverage(this: SemanticCoordinatorContext,
    projectId: number,
    generationId: number,
    namespace: string,
  ): Promise<number> {
    const generationFingerprint = this.deps.semanticStore.getGeneration(generationId)?.fingerprint;
    const fingerprint = generationFingerprint
      ? embeddingFingerprintForGeneration(generationFingerprint)
      : this.deps.memoryEmbedding.fingerprint?.() ?? 'embedding:unknown';
    const expected = new Map<string, string>();
    for (const snapshot of this.deps.db.listSnapshotsForSemanticIndex(projectId)) {
      const hash = snapshotEmbeddingTextHash(snapshot, fingerprint);
      const chunks = snapshotEmbeddingTexts(snapshot).length;
      for (let index = 0; index < chunks; index++) {
        expected.set(`snapshot:${snapshot.id}\0${index}`, hash);
      }
    }
    return this.verifyMemoryItems(generationId, namespace, expected, 'snapshot');
  },

memorySourceRows(this: SemanticCoordinatorContext, scope: 'project' | 'user', projectId: number) {
    if (scope === 'user') return this.deps.db.listAgentMemoryForSemanticIndex('user', 0);
    return [
      ...this.deps.db.listAgentMemoryForSemanticIndex('project', projectId),
      ...this.deps.db.listAgentMemoryForSemanticIndex('local', projectId),
    ];
  },

async verifyMemoryVectorCoverage(this: SemanticCoordinatorContext,
    scope: 'project' | 'user',
    projectId: number,
    generationId: number,
    namespace: string,
  ): Promise<number> {
    const generationFingerprint = this.deps.semanticStore.getGeneration(generationId)?.fingerprint;
    const fingerprint = generationFingerprint
      ? embeddingFingerprintForGeneration(generationFingerprint)
      : this.deps.memoryEmbedding.fingerprint?.() ?? 'embedding:unknown';
    const expected = new Map<string, string>();
    for (const memory of this.memorySourceRows(scope, projectId)) {
      const hash = agentMemoryEmbeddingTextHash(memory, fingerprint);
      const chunks = agentMemoryEmbeddingTexts(memory).length;
      for (let index = 0; index < chunks; index++) {
        expected.set(`agent_memory:${memory.id}\0${index}`, hash);
      }
    }
    if (scope === 'project') {
      for (
        const investigation of
        await this.deps.investigationSemanticIndex.listProject(projectId)
      ) {
        expected.set(
          `investigation:${investigation.id}\0${0}`,
          investigationEmbeddingTextHash(investigation, fingerprint),
        );
      }
    }
    return this.verifyMemoryItems(generationId, namespace, expected, 'memory');
  },

async verifyMemoryItems(this: SemanticCoordinatorContext,
    generationId: number,
    namespace: string,
    expected: ReadonlyMap<string, string>,
    label: string,
  ): Promise<number> {
    let items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    const expectedIdentities = new Set(expected.keys());
    const expectedItemKeys = new Set(Array.from(expectedIdentities, (identity) => identity.split('\0', 1)[0]));
    const obsoleteKeys = [...new Set(items
      .filter((item) => !expectedItemKeys.has(item.item_key))
      .map((item) => item.item_key))];
    if (obsoleteKeys.length > 0) {
      await this.workerDeleteItemKeys(namespace, generationId, obsoleteKeys);
    }
    const obsoleteIds = items.flatMap((item) =>
      item.vector_id
      && expectedItemKeys.has(item.item_key)
      && !expectedIdentities.has(`${item.item_key}\0${item.chunk_index}`)
        ? [item.vector_id]
        : []);
    if (obsoleteIds.length > 0) {
      await this.workerDeleteIds(namespace, generationId, obsoleteIds);
    }
    if (obsoleteKeys.length > 0 || obsoleteIds.length > 0) {
      items = this.deps.semanticStore.listItems({ generation_id: generationId, namespace });
    }
    const actual = new Map(items.map((item) => [`${item.item_key}\0${item.chunk_index}`, item]));
    if (actual.size !== items.length) {
      throw new Error(`${label} vector coverage incomplete: duplicate semantic item`);
    }
    for (const [identity, hash] of expected) {
      const item = actual.get(identity);
      if (!item || item.status !== 'indexed' || !item.vector_id || item.source_hash !== hash) {
        throw new Error(`${label} vector coverage incomplete: ${identity.replace('\0', '#')} is not current`);
      }
    }
    if (actual.size !== expected.size) {
      throw new Error(`${label} vector coverage incomplete: found ${actual.size}/${expected.size} exact items`);
    }
    await this.verifyPhysicalVectorIds(
      namespace,
      generationId,
      items.flatMap((item) => item.vector_id ? [item.vector_id] : []),
    );
    return expected.size;
  },

async verifyPhysicalVectorIds(this: SemanticCoordinatorContext,
    namespace: string,
    generationId: number,
    expectedIds: readonly string[],
  ): Promise<void> {
    const physicalIds = await this.workerListIds(namespace, generationId);
    const expected = new Set(expectedIds);
    const physical = new Set(physicalIds);
    if (expected.size !== expectedIds.length) {
      throw new Error(`physical vector coverage incomplete: duplicate ledger id in ${namespace}`);
    }
    if (physical.size !== physicalIds.length) {
      throw new Error(`physical vector coverage incomplete: duplicate sqlite-vec id in ${namespace}`);
    }
    const missing = [...expected].filter((id) => !physical.has(id));
    const extra = [...physical].filter((id) => !expected.has(id));
    // Heal crash residue deterministically while keeping this activation
    // attempt closed. Orphan physical rows can be removed immediately;
    // ledger rows whose vectors vanished are removed so the durable retry
    // embeds them again instead of trusting a stale "indexed" marker.
    if (extra.length > 0) await this.workerDeleteIds(namespace, generationId, extra);
    if (missing.length > 0) {
      this.deps.semanticStore.deleteItemsByVectorIds(generationId, namespace, missing);
    }
    if (missing.length === 0 && extra.length > 0) {
      const reconciled = new Set(await this.workerListIds(namespace, generationId));
      if (reconciled.size === expected.size && [...expected].every((id) => reconciled.has(id))) return;
    }
    if (missing.length > 0 || extra.length > 0) {
      const detail = [
        missing.length ? `missing ${missing.slice(0, 3).join(', ')}` : '',
        extra.length ? `extra ${extra.slice(0, 3).join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(
        `physical vector coverage incomplete for ${namespace}: ${physical.size}/${expected.size} ids${detail ? ` (${detail})` : ''}`,
      );
    }
  }
};
