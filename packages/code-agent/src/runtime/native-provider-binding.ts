import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';

const selections = new WeakMap<ChatProvider, Readonly<{ provider: string; model: string; adapterName: string; adapterModel: string }>>();
/** Resolved by the product's credential-aware factory, never by adapter.name. */
export function rememberNativeProviderSelection(provider: ChatProvider, selection: { provider: string; model: string }): void {
  if (!selection.provider || !selection.model) throw new Error('Native provider selection is unresolved');
  const previous = selections.get(provider);
  if (previous && (previous.provider !== selection.provider || previous.model !== selection.model)) {
    throw new Error('Native provider instance was rebound to another configured selection');
  }
  selections.set(provider, Object.freeze({ ...selection, adapterName: provider.name, adapterModel: provider.model }));
}
export function nativeProviderSelection(provider: ChatProvider) {
  const selection = selections.get(provider);
  if (selection && (selection.adapterName !== provider.name || selection.adapterModel !== provider.model)) {
    throw new Error('Native child provider changed after product resolution');
  }
  return selection;
}

/** Configured provider IDs identify credentials/endpoints, whereas adapter.name
 * identifies the protocol implementation (several accounts may use OpenAI).
 * Keep the configured selection on the wire without changing the adapter's
 * resolved vendor model or allowing a mid-attempt model switch. */
export function bindNativeProductProvider(provider: ChatProvider, selection: {
  provider: string; model: string;
}): ChatProvider {
  if (!selection.provider || !selection.model || !provider.name || !provider.model) {
    throw new Error('Native provider selection is unresolved');
  }
  const adapterName = provider.name;
  const adapterModel = provider.model;
  return Object.freeze({
    name: selection.provider,
    model: selection.model,
    setModel() { throw new Error('Native provider binding is sealed for this attempt'); },
    chat(request) {
      if (provider.name !== adapterName || provider.model !== adapterModel) {
        throw new Error('Native provider adapter changed after preparation');
      }
      return provider.chat(request);
    },
  } satisfies ChatProvider);
}
