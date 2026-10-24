import assert from 'node:assert/strict';

export function nativeDiscoveryDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('HARNESS_NATIVE_DISCOVERY'));
  if (start < 0) return;
  for (const name of ['find_tools', 'capability_catalog', 'expand_toolset']) assert(body.tools.some(t => t.function?.name === name));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index, id: `harness-discovery-${results.length}-${index}`,
    type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  const json = index => { const text = results[index].content; return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); };
  if (!results.length) return call([['capability_catalog', { op: 'list', limit: 2 }], ['find_tools', { query: 'read_file', limit: 2 }], ['expand_toolset', { tier: 'navigate' }]]);
  if (results.length === 3) {
    const page = json(0); assert.equal(page.items.length, 2); assert(page.total > 50); assert.equal(page.nextCursor, '2');
    assert.match(results[1].content, /read_file/); assert.match(results[2].content, /already visible/);
    return call([['capability_catalog', { op: 'describe', capability_ids: ['cap:native:read_file', 'cap:native:__harness_unregistered__'] }],
      ['capability_catalog', { op: 'activate', capability_ids: ['cap:native:read_file', 'cap:native:__harness_unregistered__'] }],
      ['capability_catalog', { op: 'list', limit: 2, cursor: page.nextCursor }]]);
  }
  assert.equal(results.length, 6);
  assert.equal(json(3).items[0].descriptor.name, 'read_file'); assert.equal(json(3).items[1].error, 'not_in_attempt_snapshot');
  const activated = json(4); assert.equal(activated.activated[0].effective, 'already_visible');
  assert.equal(activated.rejected[0].reason, 'not_in_attempt_snapshot');
  assert.equal(activated.projectionState, 'immutable_attempt_snapshot'); assert.match(activated.capabilitySetDigest, /^[a-f0-9]{64}$/);
  assert.equal(json(5).items.length, 2);
  assert(!json(0).items.some(first => json(5).items.some(second => first.capabilityId === second.capabilityId)));
  return { role: 'assistant', content: 'HARNESS_NATIVE_DISCOVERY_OK' };
}

export async function runNativeDiscoveryFixture({ dashboard, post, projectId, setSession }) {
  const session = await post('/api/coder/sessions', { project_id: projectId, title: 'Native discovery', provider: 'harness-local', model: 'harness-model', max_turns: 4 });
  setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90000), body: JSON.stringify({ content: 'HARNESS_NATIVE_DISCOVERY', profile: 'full', max_turns: 4 }) });
    if (!response.ok) throw new Error('Discovery fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_DISCOVERY_OK'), stream.slice(-7000));
  return { sessionId: session.id, passed: true, paginatedCatalog: true, sameAttemptActivation: true, unauthorizedCapabilityRejected: true };
}
