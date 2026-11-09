/** GLM 5.3 evaluation in an isolated profile; never writes the user's profile. */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const Database = createRequire(import.meta.url)('better-sqlite3');
const { scrubReliabilityProfile } = createRequire(import.meta.url)('./reliability-profile-cleanup.cjs');
const source = new Database(join(process.env.USERPROFILE!, '.mcp-code-indexer', 'index.db'), { readonly: true });
const config = source.prepare("SELECT * FROM provider_configs WHERE id='zai'").get();
const model = source.prepare("SELECT * FROM provider_models WHERE provider_id='zai' AND model_id='glm-5.3' AND mode='' ").get();
source.close();
if (!config?.api_key || !model) throw new Error('Authorized GLM 5.3 configuration is unavailable');
const profile = resolve('.tmp/agent-ide-reliability', `live-profile-${Date.now()}-${process.pid}`);
mkdirSync(profile, { recursive: true });
// Establish ownership and cleanup before any database or credential write.
writeFileSync(join(profile, 'evaluation-owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), provider: 'zai', model: 'glm-5.3', fixturesOnly: true }));
process.on('exit', () => {
  try {
    scrubReliabilityProfile(profile);
  } catch { /* The parent must scrub isolated profiles after hard interruption. */ }
});
process.env.MCP_DATA_DIR = profile;
process.env.MCP_INDEX_DB = join(profile, 'index.db');
process.env.MCP_RUNTIME_COORDINATION_DIR = join(profile, 'coordination');
process.env.CODER_FALLBACK_CHAIN = '';
const { CodeIndexDB } = await import('@mcp/store/db.js');
const { ProviderStore } = await import('@mcp/store/provider-store.js');
const central = new CodeIndexDB(process.env.MCP_INDEX_DB); central.close();
const store = new ProviderStore(process.env.MCP_INDEX_DB);
store.upsertProvider({ ...config, extra: JSON.parse(config.extra || '{}'), enabled: true, use_for_coder: true, is_default: true });
store.replaceModelsFromSource('zai', 'manual', [{ ...model, enabled: true, default_max_tokens: 4096 }]);
store.setFallbackProvider('zai', null); store.close();
process.argv = [process.argv[0], 'bench', '--models', 'glm-5.3', '--semantic-index', 'off', ...process.argv.slice(2)];
await import('./bench-agent-effectiveness-live.js');
