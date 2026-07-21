import type { ChatProvider, ChatRequest } from './adapter.js';
import type { ProviderRuntimeModelMetadata } from './provider.js';

/** Product-level execution profiles. These are never provider wire values. */
export const EXECUTION_MODES = ['standard', 'ultra'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Public discrete effort order shared by the current provider catalogs. */
export const REASONING_EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const VIRTUAL_REASONING_LEVELS = new Set(['ultra']);
const effortRank = new Map<string, number>(
  REASONING_EFFORT_ORDER.map((level, index) => [level, index]),
);

export interface NativeReasoningCapability {
  canReason?: boolean | null;
  supportedLevels?: readonly string[] | null;
  defaultLevel?: string | null;
}

export interface ReasoningResolution {
  effort: string | null;
  source:
    | 'ultra-highest-supported'
    | 'ultra-no-discrete-control'
    | 'explicit-supported'
    | 'explicit-unknown-capability'
    | 'unsupported'
    | 'none';
}

/**
 * Remove product-only presets from a provider's native effort catalog.
 * Discovery, UI and request adapters all use this defensive boundary so a
 * stale catalog containing `ultra` cannot accidentally turn it into a wire
 * parameter again.
 */
export function nativeReasoningLevels(
  levels: readonly unknown[] | null | undefined,
): string[] {
  if (!levels) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of levels) {
    if (typeof value !== 'string') continue;
    const level = value.trim();
    const key = level.toLowerCase();
    if (!level || VIRTUAL_REASONING_LEVELS.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(level);
  }
  return result;
}

/** Normalize one provider-native effort value, dropping virtual presets. */
export function nativeReasoningLevel(value: unknown): string | null {
  return nativeReasoningLevels([value])[0] ?? null;
}

function highestSupported(levels: readonly string[]): string | null {
  let best: { level: string; rank: number } | null = null;
  for (const level of levels) {
    const rank = effortRank.get(level.toLowerCase());
    if (rank == null) continue;
    if (!best || rank > best.rank) best = { level, rank };
  }
  // Unknown labels have no proven ordering. Without explicit max metadata,
  // omit the wire control instead of guessing which vendor value is strongest.
  return best?.level ?? null;
}

/**
 * Resolve an internal request to a provider-native discrete effort.
 *
 * `ultra` is a virtual execution preset: it selects the highest advertised
 * native value, but is omitted when the model has no discrete effort control
 * or its capability is unknown. Explicit native selections remain usable for
 * legacy/custom providers whose catalog is not available.
 */
export function resolveReasoningEffort(input: {
  requestedEffort?: string | null;
  executionMode?: ExecutionMode;
  capability?: NativeReasoningCapability | null;
}): ReasoningResolution {
  const requested = input.requestedEffort?.trim() || null;
  const virtualUltra = requested?.toLowerCase() === 'ultra';
  const ultra = input.executionMode === 'ultra' || virtualUltra;
  const capability = input.capability;
  const nativeLevels = nativeReasoningLevels(capability?.supportedLevels);

  if (capability?.canReason === false) {
    return { effort: null, source: requested || ultra ? 'unsupported' : 'none' };
  }

  if (ultra) {
    const effort = highestSupported(nativeLevels);
    return effort
      ? { effort, source: 'ultra-highest-supported' }
      : { effort: null, source: 'ultra-no-discrete-control' };
  }

  if (!requested) return { effort: null, source: 'none' };

  if (capability?.supportedLevels != null) {
    const supported = nativeLevels.find(
      (level) => level.toLowerCase() === requested.toLowerCase(),
    );
    return supported
      ? { effort: supported, source: 'explicit-supported' }
      : { effort: null, source: 'unsupported' };
  }

  return { effort: requested, source: 'explicit-unknown-capability' };
}

export interface RuntimeModelRef {
  id: string;
  mode: string | null;
}

/** Parse the host-only `model::mode` selector without leaking it to a wire. */
export function parseRuntimeModelRef(value: string): RuntimeModelRef {
  const separator = value.indexOf('::');
  if (separator < 0) return { id: value, mode: null };
  return {
    id: value.slice(0, separator),
    mode: value.slice(separator + 2) || null,
  };
}

/** Select only the metadata row for the exact host transport mode. */
export function selectRuntimeModelMetadata(
  models: readonly ProviderRuntimeModelMetadata[] | undefined,
  activeModel: string,
): ProviderRuntimeModelMetadata | undefined {
  const active = parseRuntimeModelRef(activeModel);
  const candidates = models?.filter(
    (candidate) => parseRuntimeModelRef(candidate.model_id).id === active.id,
  ) ?? [];
  if (candidates.length === 0) return undefined;
  const activeMode = active.mode ?? '';
  return candidates.find((candidate) => {
    const embeddedMode = parseRuntimeModelRef(candidate.model_id).mode;
    return (candidate.mode ?? embeddedMode ?? '') === activeMode;
  });
}

/**
 * Universal last-mile guard for every built-in/plugin ChatProvider created by
 * the host. It keeps product presets out of vendor payloads and re-resolves on
 * `setModel`, which also protects fallback and heterogeneous subagent models.
 */
export function withReasoningCapabilities(
  provider: ChatProvider,
  models: readonly ProviderRuntimeModelMetadata[] | undefined,
  selectedModel?: string,
): ChatProvider {
  let activeModel = selectedModel ?? provider.model;
  // A plugin-backed provider may be lazy: its real client is created only on
  // the first chat call. Strip the host-only transport suffix now as well as
  // on later swaps so `model::mode` cannot cross that deferred boundary.
  const initialWireModel = parseRuntimeModelRef(activeModel).id;
  if (provider.model !== initialWireModel) provider.setModel(initialWireModel);
  return {
    get name() {
      return provider.name;
    },
    get model() {
      return provider.model;
    },
    set model(nextModel: string) {
      activeModel = nextModel;
      provider.model = parseRuntimeModelRef(nextModel).id;
    },
    setModel(nextModel: string): void {
      activeModel = nextModel;
      provider.setModel(parseRuntimeModelRef(nextModel).id);
    },
    async *chat(req: ChatRequest) {
      const metadata = selectRuntimeModelMetadata(models, activeModel);
      const virtualUltra = req.reasoningEffort?.trim().toLowerCase() === 'ultra';
      const resolution = resolveReasoningEffort({
        requestedEffort: req.reasoningEffort,
        capability: metadata
          ? {
              canReason: metadata.can_reason,
              supportedLevels: metadata.supported_reasoning_levels,
              defaultLevel: metadata.default_reasoning_level,
            }
          : null,
      });
      const normalized: ChatRequest = {
        ...req,
        reasoningEffort: resolution.effort,
        // Ultra must also work for models that expose a boolean/fixed reasoning
        // capability but no discrete effort enum. This last-mile decision is
        // repeated for every swapped/fallback/subagent model. Unknown metadata
        // is left untouched; an explicit non-reasoner stays disabled.
        thinking: metadata?.can_reason === false
          ? undefined
          : virtualUltra && metadata?.can_reason === true
            ? true
            : req.thinking,
      };
      yield* provider.chat(normalized);
    },
  };
}
