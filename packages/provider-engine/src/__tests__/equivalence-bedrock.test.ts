import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedCreds, ProviderSpec, ProviderDefinition } from '@mcp/provider-sdk';

// Capture constructor opts so we can assert the engine builds the SAME adapter
// the hand-written definition does. Both the definition and the engine wire
// import these exact specifiers, so one mock intercepts both. Bedrock's
// adapters take a single OPTS OBJECT (not positional args).
const chatCalls: Array<Record<string, unknown>> = [];
const idxCalls: Array<Record<string, unknown>> = [];

vi.mock('@mcp/code-agent/providers/bedrock.js', () => ({
  BedrockChatProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    chatCalls.push(opts);
  }),
}));
vi.mock('@mcp/indexer/indexer/providers/bedrock.js', () => ({
  BedrockIndexerProvider: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    idxCalls.push(opts);
  }),
}));

import { bedrock } from '@mcp/services/providers/definitions/bedrock.js';
import { buildBedrock } from '../wires/bedrock.js';
import { bedrockSpec } from '../specs/bedrock.js';

/**
 * Mirror of `buildProviderDefinition`'s metadata mapping + wire merge, so this
 * test runs standalone (the `bedrock` wire is registered in the dispatcher
 * separately). Building the definition this way exercises the exact shape the
 * dispatcher produces.
 */
function engineDef(spec: ProviderSpec): ProviderDefinition {
  return {
    kind: spec.kind,
    displayName: spec.displayName,
    credKind: spec.credKind,
    envVars: spec.envVars,
    defaultBaseURL: spec.defaultBaseURL,
    defaultModels: spec.defaultModels,
    defaultModel: spec.defaultModel,
    pricing: spec.pricing,
    capabilities: spec.capabilities,
    visual: spec.visual,
    auth: spec.auth,
    ...buildBedrock(spec),
  };
}

const CREDS: ResolvedCreds = {
  aws: { region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' },
};

describe('bedrock equivalence: engine(spec) == definition', () => {
  beforeEach(() => {
    chatCalls.length = 0;
    idxCalls.length = 0;
  });

  it('metadata matches', () => {
    const built = engineDef(bedrockSpec);
    expect(built.kind).toBe(bedrock.kind);
    expect(built.displayName).toBe(bedrock.displayName);
    expect(built.credKind).toBe(bedrock.credKind);
    expect(built.envVars).toEqual(bedrock.envVars);
    expect(built.defaultBaseURL).toBe(bedrock.defaultBaseURL);
    expect(built.defaultModels).toEqual(bedrock.defaultModels);
    expect(built.defaultModel).toBe(bedrock.defaultModel);
    expect(built.pricing).toEqual(bedrock.pricing);
    expect(built.capabilities).toEqual(bedrock.capabilities);
    expect(built.visual).toEqual(bedrock.visual);
  });

  it('createCoder builds an identical adapter (raw model, no default)', () => {
    bedrock.createCoder!(CREDS, undefined);
    const a = chatCalls[0];
    engineDef(bedrockSpec).createCoder!(CREDS, undefined);
    const b = chatCalls[1];
    expect(b).toEqual(a);
    // model passed RAW — undefined stays undefined (adapter applies its default).
    expect(b.model).toBeUndefined();
    expect(b).toEqual({
      model: undefined,
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 's',
      sessionToken: 't',
    });
  });

  it('createCoder threads an explicit model through verbatim', () => {
    const model = 'anthropic.claude-3-opus-20240229-v1:0';
    bedrock.createCoder!(CREDS, model);
    const a = chatCalls[0];
    engineDef(bedrockSpec).createCoder!(CREDS, model);
    const b = chatCalls[1];
    expect(b).toEqual(a);
    expect(b.model).toBe(model);
  });

  it('createIndexer builds an identical adapter (raw model, opts object)', () => {
    bedrock.createIndexer!(CREDS, undefined);
    const a = idxCalls[0];
    engineDef(bedrockSpec).createIndexer!(CREDS, undefined);
    const b = idxCalls[1];
    expect(b).toEqual(a);
    expect(b).toEqual({
      model: undefined,
      region: 'us-east-1',
      accessKeyId: 'a',
      secretAccessKey: 's',
      sessionToken: 't',
    });
  });

  it('createIndexer threads an explicit model through verbatim', () => {
    const model = 'meta.llama3-70b-instruct-v1:0';
    bedrock.createIndexer!(CREDS, model);
    const a = idxCalls[0];
    engineDef(bedrockSpec).createIndexer!(CREDS, model);
    const b = idxCalls[1];
    expect(b).toEqual(a);
    expect(b.model).toBe(model);
  });

  it('missing aws creds → both pass undefined fields (default credential chain)', () => {
    const bare: ResolvedCreds = {};
    bedrock.createCoder!(bare, undefined);
    const a = chatCalls[0];
    engineDef(bedrockSpec).createCoder!(bare, undefined);
    const b = chatCalls[1];
    expect(b).toEqual(a);
    expect(b).toEqual({
      model: undefined,
      region: undefined,
      accessKeyId: undefined,
      secretAccessKey: undefined,
      sessionToken: undefined,
    });
  });
});
