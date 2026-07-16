import { availableParallelism, cpus, freemem, totalmem } from 'node:os';
import type {
  RerankerTarget,
  SemanticOnnxDtype,
} from '@mcp/store/semantic-store.js';

export const BGE_BASE_RERANKER = 'Xenova/bge-reranker-base';
export const XSMALL_RERANKER = 'mixedbread-ai/mxbai-rerank-xsmall-v1';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
export const RERANKER_MEMORY_RESERVE_BYTES = GIB;

export interface LocalRerankerHardware {
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  cpuCores: number;
  /** Only pass a non-CPU provider after a real ONNX probe approved it. */
  executionProvider?: string;
}

export interface ResolvedLocalReranker {
  enabled: boolean;
  policy: 'auto' | 'explicit';
  requestedModel: string;
  model: string | null;
  dtype: SemanticOnnxDtype;
  estimatedPeakBytes: number;
  reserveBytes: number;
  executionProvider: string;
  /** Fixed cap for small tiers; null means topK * 2 capped at 64. */
  fixedDepth: number | null;
  downgradeReason: string | null;
  hardware: LocalRerankerHardware;
}

export function detectLocalRerankerHardware(): LocalRerankerHardware {
  let cores = 1;
  try { cores = availableParallelism(); }
  catch { cores = cpus().length || 1; }
  return {
    totalMemoryBytes: totalmem(),
    availableMemoryBytes: freemem(),
    cpuCores: Math.max(1, cores),
    // CPU is the only safe default. A CUDA/DirectML/CoreML label must be
    // supplied by the worker after that execution provider passed a probe.
    executionProvider: 'cpu',
  };
}

function estimatePeakBytes(model: string, dtype: SemanticOnnxDtype): number {
  const fp32 = dtype === 'fp32';
  const fp16 = dtype === 'fp16';
  const factor = fp32 ? 4 : fp16 ? 2 : dtype === 'q4' ? 0.7 : 1;
  const q8Base = model === XSMALL_RERANKER ? 320 * MIB : 760 * MIB;
  return Math.ceil(q8Base * factor);
}

function fits(hardware: LocalRerankerHardware, peak: number): boolean {
  return hardware.availableMemoryBytes > peak + RERANKER_MEMORY_RESERVE_BYTES;
}

/** Resolve `model:auto` without loading weights. The memory check is repeated
 * immediately before worker inference so a machine that became constrained
 * after configuration still downgrades safely. */
export function resolveLocalReranker(
  target: Extract<RerankerTarget, { kind: 'onnx' }>,
  hardware: LocalRerankerHardware = detectLocalRerankerHardware(),
): ResolvedLocalReranker {
  const normalizedHardware: LocalRerankerHardware = {
    ...hardware,
    cpuCores: Math.max(1, Math.floor(hardware.cpuCores || 1)),
    executionProvider: hardware.executionProvider || 'cpu',
  };
  const automatic = target.model === 'auto';
  const dtype = target.dtype ?? 'q8';
  const lowTier = normalizedHardware.totalMemoryBytes < 16 * GIB
    || normalizedHardware.cpuCores < 6;
  const mediumTier = !lowTier && normalizedHardware.totalMemoryBytes < 32 * GIB;
  const preferredModel = automatic
    ? (lowTier || mediumTier ? XSMALL_RERANKER : BGE_BASE_RERANKER)
    : target.model;
  const fixedDepth = automatic
    ? (lowTier ? 20 : mediumTier ? 40 : null)
    : null;
  const preferredPeak = estimatePeakBytes(preferredModel, dtype);
  if (fits(normalizedHardware, preferredPeak)) {
    return {
      enabled: true,
      policy: automatic ? 'auto' : 'explicit',
      requestedModel: target.model,
      model: preferredModel,
      dtype,
      estimatedPeakBytes: preferredPeak,
      reserveBytes: RERANKER_MEMORY_RESERVE_BYTES,
      executionProvider: normalizedHardware.executionProvider!,
      fixedDepth,
      downgradeReason: null,
      hardware: normalizedHardware,
    };
  }

  const xsmallPeak = estimatePeakBytes(XSMALL_RERANKER, 'q8');
  if (preferredModel !== XSMALL_RERANKER && fits(normalizedHardware, xsmallPeak)) {
    return {
      enabled: true,
      policy: automatic ? 'auto' : 'explicit',
      requestedModel: target.model,
      model: XSMALL_RERANKER,
      dtype: 'q8',
      estimatedPeakBytes: xsmallPeak,
      reserveBytes: RERANKER_MEMORY_RESERVE_BYTES,
      executionProvider: normalizedHardware.executionProvider!,
      fixedDepth: Math.min(fixedDepth ?? 40, 40),
      downgradeReason: `available memory is below the ${preferredModel} safety envelope`,
      hardware: normalizedHardware,
    };
  }

  return {
    enabled: false,
    policy: automatic ? 'auto' : 'explicit',
    requestedModel: target.model,
    model: null,
    dtype: 'q8',
    estimatedPeakBytes: xsmallPeak,
    reserveBytes: RERANKER_MEMORY_RESERVE_BYTES,
    executionProvider: normalizedHardware.executionProvider!,
    fixedDepth: fixedDepth ?? 20,
    downgradeReason: 'no local reranker fits available memory with the 1 GB reserve',
    hardware: normalizedHardware,
  };
}

export function resolvedRerankDepth(
  resolved: Pick<ResolvedLocalReranker, 'fixedDepth'>,
  topK: number,
  availableCandidates: number,
): number {
  const requested = Math.max(1, Math.floor(topK));
  const policyDepth = resolved.fixedDepth ?? Math.min(64, requested * 2);
  return Math.min(availableCandidates, Math.max(requested, policyDepth));
}

