import { type CoordinatorDeps } from './semantic-coordinator-shared.js';

import { operations as operations8 } from './semantic-coordinator-code-build.js';
import { operations as operations9 } from './semantic-coordinator-code-coverage.js';
import { operations as operations4 } from './semantic-coordinator-code-delta.js';
import { operations as operations2 } from './semantic-coordinator-code-requests.js';
import { SemanticCoordinatorContext } from './semantic-coordinator-context.js';
import { operations as operations0 } from './semantic-coordinator-control.js';
import { operations as operations6 } from './semantic-coordinator-docs-backfill.js';
import { operations as operations10 } from './semantic-coordinator-docs-build.js';
import { operations as operations7 } from './semantic-coordinator-generations.js';
import { operations as operations13 } from './semantic-coordinator-knowledge-coverage.js';
import { operations as operations3 } from './semantic-coordinator-knowledge-requests.js';
import { operations as operations11 } from './semantic-coordinator-memory-build.js';
import { operations as operations12 } from './semantic-coordinator-memory-reconciliation.js';
import { operations as operations14 } from './semantic-coordinator-namespace-lifecycle.js';
import { operations as operations5 } from './semantic-coordinator-project-removal.js';
import { operations as operations1 } from './semantic-coordinator-unused-vector-cleanup.js';

function initialize(this: SemanticCoordinatorContext, deps: CoordinatorDeps): void {

    if (deps.recoverMutationFences) {
      // Fence resolution can scan source rows and acquire IMMEDIATE. Keep it
      // off Electron-main; catch-up and new docs mutations wait on this
      // promise, while unrelated renderer/SSE work remains available. A
      // failed worker call is not converted into success: the next semantic
      // operation retries recovery before it may mutate or reconcile.
      this.startMutationFenceRecovery();
    } else {
      // Tests/headless runtimes retain the synchronous contract, but never
      // inherit a multi-second busy wait.
      this.recoverMutationFencesLocallyFailFast();
      this.mutationFenceRecovery = Promise.resolve();
    }
    // Keep completed removal markers fenced until the caller deletes the
    // project row. This survives a crash in the gap after vectors.db is gone.
    for (const projectId of deps.semanticStore.listProjectRemovalIds()) this.projectTombstones.add(projectId);
    // External clients can publish a marker without sharing this process's
    // in-memory Set. Polling is a recovery path for a failed/missed localhost
    // wake-up and also closes the crash gap after physical cleanup.
    this.scheduleProjectRemovalRetry(1_000);

}

export function createSemanticCoordinator(deps: CoordinatorDeps): SemanticCoordinatorContext {
  const context = Object.assign(new SemanticCoordinatorContext(deps), operations0, operations1, operations2, operations3, operations4, operations5, operations6, operations7, operations8, operations9, operations10, operations11, operations12, operations13, operations14);
  initialize.call(context, deps);
  return context;
}
