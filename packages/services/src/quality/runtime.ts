/** Shared construction for the hybrid Quality runtime (main thread + workers). */
import type DatabaseConstructor from 'better-sqlite3';
import type { TelemetrySink } from '@mcp/candidate-pipeline/stats.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { PipelineProviderBindingsStore } from '@mcp/store/pipeline-provider-bindings-store.js';
import { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import { PipelineProviderResolver } from '../pipelines/provider-resolver.js';
import { CombinedQualityClassifier } from './classifiers.js';
import { QualityClassifierPipeline } from './quality-pipeline.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface QualityRuntime {
  classificationStore: QualityClassificationStore;
  pipeline: QualityClassifierPipeline;
}

export function createQualityRuntime(
  db: DB,
  opts: { telemetry?: TelemetrySink } = {},
): QualityRuntime {
  const resolver = new PipelineProviderResolver(
    new PipelineProviderBindingsStore(db),
    new ProviderStore(db),
  );
  const classificationStore = new QualityClassificationStore(db);
  const pipeline = new QualityClassifierPipeline({
    classifiers: [
      new CombinedQualityClassifier(resolver, {
        singleAttempt: true,
        retry: { maxRetries: 0 },
        timeoutMs: 10_000,
        maxTokens: 384,
      }),
    ],
    store: classificationStore,
    telemetry: opts.telemetry,
    maxConcurrency: 1,
  });
  return { classificationStore, pipeline };
}
