import type { ProviderSpec, ProviderDefinition, WireKind } from '@mcp/provider-sdk';
import { withStreamResilience } from '@mcp/provider-sdk';
import { buildOpenAICompat } from './wires/openai-compat.js';
import { buildAnthropic } from './wires/anthropic.js';
import { buildGemini } from './wires/gemini.js';
import { buildBedrock } from './wires/bedrock.js';
import { buildKimi } from './wires/kimi.js';
import { buildCodex } from './wires/codex.js';
import { buildTestConnection } from './wire-helpers/test-connection.js';

type WireBuilder = (spec: ProviderSpec) => Pick<
  ProviderDefinition,
  'createCoder' | 'createIndexer' | 'createIndexerAsync' | 'fetchModels' | 'testConnection'
>;

/** wire → builder. All 6 wires registered. */
const WIRES: Partial<Record<WireKind, WireBuilder>> = {
  'openai-compat': buildOpenAICompat,
  anthropic: buildAnthropic,
  gemini: buildGemini,
  bedrock: buildBedrock,
  kimi: buildKimi,
  codex: buildCodex,
};

/**
 * Turn a declarative `ProviderSpec` into a runtime `ProviderDefinition` (the ABI
 * the registry/factory/resolver consume). The metadata maps straight through;
 * the per-wire builder supplies the imperative adapter/test functions.
 */
export function buildProviderDefinition(spec: ProviderSpec): ProviderDefinition {
  const wire = WIRES[spec.wire];
  if (!wire) {
    throw new Error(`provider-engine: no builder for wire '${spec.wire}' (kind '${spec.kind}')`);
  }
  const built = wire(spec);
  const baseCreateCoder = built.createCoder;
  return {
    kind: spec.kind,
    displayName: spec.displayName,
    credKind: spec.credKind,
    envVars: spec.envVars,
    defaultBaseURL: spec.defaultBaseURL,
    defaultModels: spec.defaultModels,
    defaultModel: spec.defaultModel,
    pricing: spec.pricing,
    pricingPriority: spec.pricingPriority,
    capabilities: spec.capabilities,
    visual: spec.visual,
    auth: spec.auth,
    config: spec.config,
    ...built,
    // Every coder provider gets stream resilience: Node 24's undici flags a
    // late "Premature close" on an already-complete stream as an error.
    // withStreamResilience swallows that benign trailing close (and re-throws
    // genuine mid-stream truncations). Set after `...built` so it wins.
    createCoder: baseCreateCoder
      ? (creds, model, opts) => withStreamResilience(baseCreateCoder(creds, model, opts))
      : baseCreateCoder,
    // testConnection is wire-orthogonal (driven by spec.test); set last so it
    // wins over any wire default. Undefined when no `test` is declared.
    testConnection: buildTestConnection(spec),
  };
}
