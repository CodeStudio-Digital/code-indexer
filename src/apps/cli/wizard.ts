import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../../utils/config.js';
import { ProviderStore } from '../../store/provider-store.js';
import type { InitOverrides } from '../../utils/config.js';

/**
 * Interactive wizard for `mcp-code-indexer init --interactive`.
 *
 * Uses Node's built-in readline/promises so we don't add a prompt dependency.
 * Consults the ProviderStore when available so users see their admin-managed
 * providers and models; falls back to a hardcoded list when the DB is empty
 * or not yet initialized (fresh install, user ran init before any server).
 *
 * `useDefaults=true` (from --yes) skips prompts and returns the DB defaults,
 * intended for CI that still wants description/provider/model written into
 * .mcp-indexer.json based on the current admin state.
 */
export async function runInitWizard(useDefaults: boolean): Promise<InitOverrides> {
  let store: ProviderStore | null = null;
  try {
    const cfg = loadConfig();
    store = new ProviderStore(cfg.dbPath);
    store.seedFromEnvIfEmpty();
  } catch {
    store = null;
  }

  const providerRows = store
    ? store.listProviders({ enabled: true, use_for_agent: true })
    : [];

  // Fallback choices come from the provider registry — no hardcoded list.
  const { listDefinitions } = await import('../../core/providers/registry.js');
  const providerChoices = providerRows.length > 0
    ? providerRows.map((p) => ({ id: p.id, label: `${p.name} (${p.kind})` }))
    : listDefinitions()
        .filter((d) => d.credKind === 'api-key') // wizard only seeds api-key shapes
        .map((d) => ({ id: d.kind, label: d.displayName }));
  const defaultProvider = providerRows.find((p) => p.is_default)?.id ?? providerChoices[0].id;

  const embeddingConfigs = store ? store.listEmbeddingConfigs().filter((c) => c.enabled) : [];

  if (useDefaults) {
    const result: InitOverrides = {
      provider: defaultProvider,
      embeddingsEnabled: embeddingConfigs.some((c) => c.is_default),
    };
    if (store) {
      const models = store.listModels(defaultProvider, true);
      if (models[0]) result.model = models[0].model_id;
    }
    return result;
  }

  const rl = createInterface({ input, output });
  try {
    console.log('');
    console.log('MCP Code Indexer — interactive init');
    console.log('Press Enter to accept defaults shown in [brackets].');
    console.log('');

    const description = (await rl.question('Project description (optional): ')).trim();

    console.log('');
    console.log('Available providers:');
    providerChoices.forEach((p, i) => {
      const marker = p.id === defaultProvider ? '*' : ' ';
      console.log(`  ${marker} ${i + 1}. ${p.label}`);
    });
    const providerAns = (
      await rl.question(`Select provider [${defaultProvider}]: `)
    ).trim();
    let provider = defaultProvider;
    if (providerAns) {
      const asNum = parseInt(providerAns, 10);
      if (!isNaN(asNum) && asNum >= 1 && asNum <= providerChoices.length) {
        provider = providerChoices[asNum - 1].id;
      } else if (providerChoices.some((p) => p.id === providerAns)) {
        provider = providerAns;
      } else {
        console.log(`  (unknown provider "${providerAns}", keeping ${defaultProvider})`);
      }
    }

    let model: string | undefined;
    const availableModels = store ? store.listModels(provider, true) : [];
    if (availableModels.length > 0) {
      console.log('');
      console.log(`Models for ${provider}:`);
      availableModels.slice(0, 15).forEach((m, i) => {
        const suffix = m.mode ? ` [${m.mode}]` : '';
        console.log(`    ${i + 1}. ${m.model_id}${suffix}`);
      });
      const defaultModel = availableModels[0].model_id;
      const modelAns = (await rl.question(`Select model [${defaultModel}]: `)).trim();
      if (modelAns) {
        const asNum = parseInt(modelAns, 10);
        if (!isNaN(asNum) && asNum >= 1 && asNum <= availableModels.length) {
          model = availableModels[asNum - 1].model_id;
        } else {
          model = modelAns;
        }
      } else {
        model = defaultModel;
      }
    } else {
      const modelAns = (await rl.question('Model name (free text, leave blank for provider default): ')).trim();
      if (modelAns) model = modelAns;
    }

    let embeddingsEnabled = false;
    if (embeddingConfigs.length > 0) {
      console.log('');
      console.log('Embedding backends configured in admin:');
      embeddingConfigs.forEach((c) => {
        const def = c.is_default ? ' (default)' : '';
        console.log(`   • ${c.id} — ${c.kind}${def}`);
      });
      const embAns = (await rl.question('Enable embeddings for this project? [Y/n] ')).trim().toLowerCase();
      embeddingsEnabled = embAns !== 'n' && embAns !== 'no';
    } else {
      console.log('');
      console.log('No embedding backend configured. Open the dashboard /admin → Embeddings to set one up.');
      const embAns = (await rl.question('Enable embeddings anyway? [y/N] ')).trim().toLowerCase();
      embeddingsEnabled = embAns === 'y' || embAns === 'yes';
    }

    return {
      description: description || undefined,
      provider,
      model,
      embeddingsEnabled,
    };
  } finally {
    rl.close();
    if (store) store.close();
  }
}
