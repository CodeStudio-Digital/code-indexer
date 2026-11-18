import type {
  ChatProvider,
  ChatRequest,
  ChatDelta,
  CreateCoderOpts,
  ProviderAuthHandlers,
  ProviderDefinition,
  ProviderRuntimeAdapter,
  ProviderSpec,
  ResolvedCreds,
} from '@mcp/provider-sdk';
import { importPluginBundle } from './import-plugin-bundle.js';

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
  const promise = importPluginBundle<ProviderAdapterModule>(ref.file).then((mod) => {
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
  private clientSlot?: { model: string; client?: ChatProvider; pending: Promise<ChatProvider> };

  constructor(
    private readonly ref: ProviderAdapterRuntimeRef,
    private readonly kind: string,
    private readonly creds: ResolvedCreds,
    model: string,
    private readonly opts?: CreateCoderOpts,
    private readonly hostDefinition?: ProviderDefinition,
  ) {
    this.name = kind;
    this.model = model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  private get activeClient(): ChatProvider | undefined {
    return this.clientSlot?.model === this.model ? this.clientSlot.client : undefined;
  }

  get inferenceOnly() { return this.activeClient?.inferenceOnly; }
  get reasoningCapabilities() { return this.activeClient?.reasoningCapabilities; }
  get toolLimits() { return this.activeClient?.toolLimits; }

  private async createClient(model: string): Promise<ChatProvider> {
    const adapter = await loadAdapter(this.ref, this.kind);
    const client = adapter.createCoder
      ? await adapter.createCoder({
          kind: this.kind,
          creds: this.creds,
          model,
          opts: this.opts,
        })
      : this.hostDefinition?.createCoder?.(this.creds, model, this.opts);
    if (!client) throw new Error(`Provider '${this.kind}' does not support the coder`);
    client.setModel(model);
    return client;
  }

  private getClient(): Promise<ChatProvider> {
    if (this.clientSlot?.model === this.model) return this.clientSlot.pending;
    // Keep transport pools and continuation state for this provider instance.
    // Model changes rebuild model-dependent options; credentials belong to this
    // instance, never to the module cache shared by other sessions/accounts.
    const slot = {
      model: this.model,
      pending: this.createClient(this.model),
      client: undefined as ChatProvider | undefined,
    };
    slot.pending = slot.pending.then((client) => {
      slot.client = client;
      return client;
    }, (error: unknown) => {
      if (this.clientSlot === slot) this.clientSlot = undefined;
      throw error;
    });
    this.clientSlot = slot;
    return slot.pending;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const client = await this.getClient();
    yield* client.chat(req);
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
  hostDefinition: ProviderDefinition,
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
      if (adapter.fetchModels) return adapter.fetchModels({ kind: spec.kind, creds, model: defaultModel });
      return hostDefinition.fetchModels?.(creds) ?? spec.defaultModels;
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
      else await hostDefinition.testConnection?.({ config, creds });
    },
    createCoder(creds, model, opts) {
      return new PluginChatProvider(ref, spec.kind, creds, model ?? defaultModel, opts, hostDefinition);
    },
  };
}
