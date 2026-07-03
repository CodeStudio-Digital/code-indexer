import { pathToFileURL } from 'node:url';
import type {
  ChatProvider,
  ChatRequest,
  ChatDelta,
  CreateCoderOpts,
  LLMProvider,
  ProviderAuthHandlers,
  ProviderDefinition,
  ProviderRuntimeAdapter,
  ProviderSpec,
  ResolvedCreds,
} from '@mcp/provider-sdk';

export interface ProviderAdapterRuntimeRef {
  namespace: string;
  file: string;
  kinds: string[];
}

type ProviderAdapterModule = {
  providerAdapter?: ProviderRuntimeAdapter;
  providerAdapters?: ProviderRuntimeAdapter[];
};

export class ProviderPluginMethodNotImplementedError extends Error {
  readonly code = 'PROVIDER_PLUGIN_METHOD_NOT_IMPLEMENTED';

  constructor(
    readonly kind: string,
    readonly method: string,
  ) {
    super(`Provider '${kind}' adapter does not implement ${method}`);
  }
}

export function isProviderPluginMethodNotImplementedError(
  err: unknown,
): err is ProviderPluginMethodNotImplementedError {
  return (
    err instanceof ProviderPluginMethodNotImplementedError ||
    (typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'PROVIDER_PLUGIN_METHOD_NOT_IMPLEMENTED')
  );
}

const adapterCache = new Map<string, Promise<ProviderRuntimeAdapter[]>>();

async function importAdapters(ref: ProviderAdapterRuntimeRef): Promise<ProviderRuntimeAdapter[]> {
  const cacheKey = `${ref.namespace}:${ref.file}`;
  const cached = adapterCache.get(cacheKey);
  if (cached) return cached;
  const promise = import(pathToFileURL(ref.file).href).then((mod: ProviderAdapterModule) => {
    const adapters = [
      ...(mod.providerAdapter ? [mod.providerAdapter] : []),
      ...(Array.isArray(mod.providerAdapters) ? mod.providerAdapters : []),
    ].filter((a): a is ProviderRuntimeAdapter => a?.sdkVersion === 2 && typeof a.kind === 'string');
    return adapters;
  });
  adapterCache.set(cacheKey, promise);
  return promise;
}

async function loadAdapter(ref: ProviderAdapterRuntimeRef, kind: string): Promise<ProviderRuntimeAdapter> {
  const adapter = (await importAdapters(ref)).find((a) => a.kind === kind);
  if (!adapter) {
    throw new Error(`provider adapter '${kind}' not exported by plugin '${ref.namespace}'`);
  }
  return adapter;
}

class PluginChatProvider implements ChatProvider {
  readonly name: string;
  model: string;

  constructor(
    private readonly ref: ProviderAdapterRuntimeRef,
    private readonly kind: string,
    private readonly creds: ResolvedCreds,
    model: string,
    private readonly opts?: CreateCoderOpts,
  ) {
    this.name = kind;
    this.model = model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const adapter = await loadAdapter(this.ref, this.kind);
    if (!adapter.createCoder) throw new Error(`Provider '${this.kind}' does not support the coder`);
    const client = await adapter.createCoder({
      kind: this.kind,
      creds: this.creds,
      model: this.model,
      opts: this.opts,
    });
    client.setModel(this.model);
    yield* client.chat(req);
  }
}

class PluginIndexerProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly summaryModel?: string;

  constructor(
    private readonly ref: ProviderAdapterRuntimeRef,
    private readonly kind: string,
    private readonly creds: ResolvedCreds,
    model: string,
    summaryModel?: string,
  ) {
    this.name = kind;
    this.model = model;
    this.summaryModel = summaryModel;
  }

  private async client(): Promise<LLMProvider> {
    const adapter = await loadAdapter(this.ref, this.kind);
    if (!adapter.createIndexer) throw new Error(`Provider '${this.kind}' does not support the indexer`);
    return adapter.createIndexer({
      kind: this.kind,
      creds: this.creds,
      model: this.model,
    });
  }

  async analyzeFile(filePath: string, content: string) {
    return (await this.client()).analyzeFile(filePath, content);
  }

  async analyzeSummary(
    filePath: string,
    content: string,
    symbols: Array<{ name: string; kind: string; signature: string; line?: number | null; end_line?: number }>,
  ) {
    const client = await this.client();
    return client.analyzeSummary
      ? client.analyzeSummary(filePath, content, symbols)
      : client.analyzeFile(filePath, content);
  }
}

function buildAuthHandlers(ref: ProviderAdapterRuntimeRef, kind: string): ProviderAuthHandlers {
  return {
    async start(ctx, input) {
      const adapter = await loadAdapter(ref, kind);
      const handler = adapter.authHandlers?.start;
      if (!handler) throw new ProviderPluginMethodNotImplementedError(kind, 'authHandlers.start');
      return handler(ctx, input);
    },
    async poll(ctx, state) {
      const adapter = await loadAdapter(ref, kind);
      const handler = adapter.authHandlers?.poll;
      if (!handler) throw new ProviderPluginMethodNotImplementedError(kind, 'authHandlers.poll');
      return handler(ctx, state);
    },
    async refresh(ctx) {
      const adapter = await loadAdapter(ref, kind);
      const handler = adapter.authHandlers?.refresh;
      if (!handler) throw new ProviderPluginMethodNotImplementedError(kind, 'authHandlers.refresh');
      return handler(ctx);
    },
    async logout(ctx) {
      const adapter = await loadAdapter(ref, kind);
      const handler = adapter.authHandlers?.logout;
      if (!handler) throw new ProviderPluginMethodNotImplementedError(kind, 'authHandlers.logout');
      return handler(ctx);
    },
  };
}

export function buildProviderPluginDefinition(
  spec: ProviderSpec,
  ref: ProviderAdapterRuntimeRef,
): ProviderDefinition {
  const defaultModel = spec.defaultModel ?? spec.defaultModels[0] ?? '';
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
    authHandlers: spec.auth?.mode === 'oauth' ? buildAuthHandlers(ref, spec.kind) : undefined,
    config: spec.config,
    async resolveCredentials(ctx) {
      const adapter = await loadAdapter(ref, spec.kind);
      if (!adapter.resolveCredentials) {
        throw new Error(`Provider '${spec.kind}' adapter does not implement resolveCredentials`);
      }
      return adapter.resolveCredentials(ctx);
    },
    async fetchModels(creds) {
      const adapter = await loadAdapter(ref, spec.kind);
      if (!adapter.fetchModels) return spec.defaultModels;
      return adapter.fetchModels({ kind: spec.kind, creds, model: defaultModel });
    },
    async discoverModels(ctx) {
      const adapter = await loadAdapter(ref, spec.kind);
      if (!adapter.discoverModels) {
        throw new ProviderPluginMethodNotImplementedError(spec.kind, 'discoverModels');
      }
      return adapter.discoverModels(ctx);
    },
    async testConnection({ config, creds }) {
      const adapter = await loadAdapter(ref, spec.kind);
      if (adapter.testConnection) await adapter.testConnection({ config, creds });
    },
    createIndexer(creds, model) {
      return new PluginIndexerProvider(ref, spec.kind, creds, model ?? defaultModel);
    },
    createCoder(creds, model, opts) {
      return new PluginChatProvider(ref, spec.kind, creds, model ?? defaultModel, opts);
    },
  };
}
