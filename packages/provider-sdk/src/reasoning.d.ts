import type { ChatProvider } from './adapter.js';
import type { ProviderRuntimeModelMetadata } from './provider.js';
/** Product-level execution profiles. These are never provider wire values. */
export declare const EXECUTION_MODES: readonly ["standard", "ultra"];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
/** Public discrete effort order shared by the current provider catalogs. */
export declare const REASONING_EFFORT_ORDER: readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export interface NativeReasoningCapability {
    canReason?: boolean | null;
    supportedLevels?: readonly string[] | null;
    defaultLevel?: string | null;
}
export interface ReasoningResolution {
    effort: string | null;
    source: 'ultra-highest-supported' | 'ultra-no-discrete-control' | 'explicit-supported' | 'explicit-unknown-capability' | 'unsupported' | 'none';
}
/**
 * Remove product-only presets from a provider's native effort catalog.
 * Discovery, UI and request adapters all use this defensive boundary so a
 * stale catalog containing `ultra` cannot accidentally turn it into a wire
 * parameter again.
 */
export declare function nativeReasoningLevels(levels: readonly unknown[] | null | undefined): string[];
/** Normalize one provider-native effort value, dropping virtual presets. */
export declare function nativeReasoningLevel(value: unknown): string | null;
/**
 * Resolve an internal request to a provider-native discrete effort.
 *
 * `ultra` is a virtual execution preset: it selects the highest advertised
 * native value, but is omitted when the model has no discrete effort control
 * or its capability is unknown. Explicit native selections remain usable for
 * legacy/custom providers whose catalog is not available.
 */
export declare function resolveReasoningEffort(input: {
    requestedEffort?: string | null;
    executionMode?: ExecutionMode;
    capability?: NativeReasoningCapability | null;
}): ReasoningResolution;
export interface RuntimeModelRef {
    id: string;
    mode: string | null;
}
/** Parse the host-only `model::mode` selector without leaking it to a wire. */
export declare function parseRuntimeModelRef(value: string): RuntimeModelRef;
/** Select only the metadata row for the exact host transport mode. */
export declare function selectRuntimeModelMetadata(models: readonly ProviderRuntimeModelMetadata[] | undefined, activeModel: string): ProviderRuntimeModelMetadata | undefined;
/**
 * Universal last-mile guard for every built-in/plugin ChatProvider created by
 * the host. It keeps product presets out of vendor payloads and re-resolves on
 * `setModel`, which also protects fallback and heterogeneous subagent models.
 */
export declare function withReasoningCapabilities(provider: ChatProvider, models: readonly ProviderRuntimeModelMetadata[] | undefined, selectedModel?: string): ChatProvider;
//# sourceMappingURL=reasoning.d.ts.map