import assert from 'node:assert/strict';

export function nativeModelsDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_MODELS/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  assert(body.tools.some(t => t.function?.name === 'mcp__list_models'));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  if (!results.length) return { role: 'assistant', tool_calls: [
    { provider: 'catalog-fixture', limit: 2 }, { provider: 'catalog-fixture', offset: 500 }, { limit: -1 },
  ].map((args, index) => ({ index, id: `harness-models-${index}`, type: 'function',
    function: { name: 'mcp__list_models', arguments: JSON.stringify(args) } })) };
  assert.equal(results.length, 3);
  assert.match(results[0].content, /"next_offset":2/); assert(!results[0].content.includes('fixture-0002'));
  assert.match(results[1].content, /fixture-0552/); assert(!results[1].content.includes('fixture-0499'));
  assert.match(results[2].content, /Invalid model catalog page/);
  return { role: 'assistant', content: 'HARNESS_NATIVE_MODELS_OK' };
}

export async function runNativeModelsFixture({ app, dashboard, post, projectId, setSession }) {
  await app.evaluate(({ app }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { ProviderStore } = require(join(app.getAppPath(), 'dist/packages/store/src/provider-store.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      const store = new ProviderStore(db.raw());
      store.upsertProvider({ id: 'catalog-fixture', name: 'Catalog fixture', kind: 'openai', enabled: true });
      store.replaceModelsFromSource('catalog-fixture', 'manual', Array.from({ length: 553 }, (_, n) => ({
        model_id: 'fixture-' + String(n).padStart(4, '0'), name: 'Fixture ' + String(n).padStart(4, '0'), enabled: true,
      })));
    } finally { db.close(); }
  });
  const session = await post('/api/coder/sessions', { project_id: projectId, title: 'Native model catalog',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 3 });
  setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: 'HARNESS_NATIVE_MODELS', profile: 'full', max_turns: 3 }) });
    if (!response.ok) throw new Error('Model fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_MODELS_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, total: 553, paginatedTailRecovered: true };
}
