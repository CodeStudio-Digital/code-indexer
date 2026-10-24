/**
 * Narrow boundary to the new package being landed in parallel. Keep all direct
 * imports here so migrator internals are insulated from repository API churn.
 */
import {
  SessionLocator,
} from '../../packages/session-storage/src/session-locator.js';
import { ArtifactStore } from '../../packages/session-storage/src/artifact-store.js';
import { canonicalJson } from '../../packages/session-storage/src/atomic-file.js';
import { calculateSessionMetricsSummary } from '../../packages/session-storage/src/metrics-summary.js';
import { CompanySessionRepository } from '../../packages/session-storage/src/entities/company-session-repository.js';
import { EntityFileRepository } from '../../packages/session-storage/src/entities/entity-file-repository.js';
import {
  asSessionId,
  type ArtifactRef,
  type ConversationCommit,
  type JsonValue,
  type ProjectRootResolver,
  type SessionMetadata,
  type SessionState,
  type SessionStorageScope,
} from '../../packages/session-storage/src/types.js';

export {
  SessionLocator,
  ArtifactStore,
  canonicalJson,
  calculateSessionMetricsSummary,
  CompanySessionRepository,
  EntityFileRepository,
  asSessionId,
};

export type {
  ArtifactRef,
  ConversationCommit,
  JsonValue,
  ProjectRootResolver,
  SessionMetadata,
  SessionState,
  SessionStorageScope,
};
