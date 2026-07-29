import type { SessionId } from '@mcp/session-storage';
import type { ReviewIntelPort } from '@mcp/services/services/review-intel-port.js';
import type {
  SessionReviewStorePort,
  SessionSnapshotStorePort,
} from '@mcp/services/services/session-snapshot-port.js';
import { FsSessionEntityFiles } from './entity-files.js';
import {
  FsReviewEvidenceRepository,
  type FsReviewEvidenceSource,
} from './review-evidence-repository.js';
import { FsSessionReviewRepository } from './review-repository.js';
import { FsSessionDirectory } from './session-directory.js';
import { FsSessionSnapshotRepository } from './snapshot-repository.js';

export interface FsSnapshotReviewApi
  extends SessionSnapshotStorePort<SessionId, string>,
    SessionReviewStorePort<SessionId, string>,
    ReviewIntelPort<SessionId, string>,
    FsReviewEvidenceSource {}

function installMethods(target: object, source: object): void {
  const prototype = Object.getPrototypeOf(source) as object;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor' || name === 'sessionIdForBaseline') continue;
    const method = Reflect.get(source, name) as unknown;
    if (typeof method !== 'function') continue;
    if (name in target) {
      throw new Error(`Duplicate filesystem session API method ${name}`);
    }
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (method as (...args: unknown[]) => unknown).bind(source),
    });
  }
}

export function installSnapshotReviewApi(
  target: object,
  directory: FsSessionDirectory,
): void {
  const entities = new FsSessionEntityFiles(directory);
  const snapshots = new FsSessionSnapshotRepository(directory, entities);
  const reviews = new FsSessionReviewRepository(
    directory,
    entities,
    snapshots,
  );
  const evidence = new FsReviewEvidenceRepository(directory, snapshots);
  installMethods(target, snapshots);
  installMethods(target, reviews);
  installMethods(target, evidence);
}
