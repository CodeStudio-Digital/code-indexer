import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const id = 'harness-owned-skill', foreignId = 'harness-foreign-skill';
const input = { id, name: 'Harness owned skill', description: 'Fixture skill for bounded read practices', prompt_body: 'HARNESS_SKILL_BODY_V1: use bounded reads.', allowed_tools: ['read_file'] };
export function nativeSkillAuthoringDelta(body) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_SKILL_(DRY|CREATE|UPDATE|RECOVER)/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_SKILL_(DRY|CREATE|UPDATE|RECOVER)/)[1];
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-skill-${stage}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  const get = ['get_skill_content', { skill_id: id }];
  if (!results.length) {
    assert(body.tools.some(t => t.function?.name === 'create_skill'));
    if (stage === 'DRY') return call([['create_skill', { ...input, scope: 'project', dry_run: true }]]);
    if (stage === 'CREATE') return call([['create_skill', { ...input, scope: 'project' }], ['create_skill', { ...input, id: foreignId, scope: 'project' }], get]);
    if (stage === 'UPDATE') return call([get, ['create_skill', { ...input, prompt_body: 'HARNESS_SKILL_BODY_V2: preserve durable evidence.' }], get]);
    return call([get]);
  }
  if (stage === 'DRY') { assert.equal(results.length, 1); assert.match(results[0].content, /dry run/); }
  if (stage === 'CREATE') {
    assert.equal(results.length, 3); assert.match(results[0].content, /Created and saved/);
    assert.match(results[1].content, /another project/); assert.match(results[2].content, /not found/);
  }
  if (stage === 'UPDATE') {
    assert.equal(results.length, 3); assert.match(results[0].content, /HARNESS_SKILL_BODY_V1/);
    assert.match(results[1].content, /Updated and saved/); assert.match(results[2].content, /HARNESS_SKILL_BODY_V1/);
    assert(!results[2].content.includes('HARNESS_SKILL_BODY_V2'));
  }
  if (stage === 'RECOVER') { assert.equal(results.length, 1); assert.match(results[0].content, /HARNESS_SKILL_BODY_V2/); }
  return { role: 'assistant', content: `HARNESS_NATIVE_SKILL_${stage}_OK` };
}
async function send(dashboard, sessionId, stage) {
  const stream = await dashboard.evaluate(async ({ sessionId, stage }) => {
    const r = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000), body: JSON.stringify({ content: `HARNESS_NATIVE_SKILL_${stage}`, profile: 'full', max_turns: 4 }) });
    if (!r.ok) throw new Error('Skill authoring HTTP ' + r.status + ': ' + (await r.text()).slice(0, 1000)); return r.text();
  }, { sessionId, stage });
  assert(stream.includes(`HARNESS_NATIVE_SKILL_${stage}_OK`), stream.slice(-7000));
}
async function read(app, skillId) {
  return app.evaluate(({ app }, skillId) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { SkillStore } = require(join(app.getAppPath(), 'dist/packages/store/src/skill-store.js'));
    const store = new SkillStore(process.env.MCP_INDEX_DB);
    try { return store.getSkill(skillId); } finally { store.close(); }
  }, skillId);
}
export async function runNativeSkillAuthoringFixture({ app, dashboard, post, root, setSession }) {
  const caseRoot = join(dirname(root), 'skill-authoring'); await mkdir(caseRoot);
  const project = await post('/api/projects', { name: 'Native skill authoring', root_path: caseRoot });
  await app.evaluate(({ app }, { foreignId, scope }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { SkillStore } = require(join(app.getAppPath(), 'dist/packages/store/src/skill-store.js'));
    const store = new SkillStore(process.env.MCP_INDEX_DB);
    try { store.upsertSkill({ id: foreignId, name: 'Foreign', prompt_body: 'Foreign instructions stay intact.', scope }); }
    finally { store.close(); }
  }, { foreignId, scope: String(project.id + 999) });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native skill authoring', provider: 'harness-local', model: 'harness-model', max_turns: 4 });
  setSession(session.id); await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
  await send(dashboard, session.id, 'DRY'); assert.equal(await read(app, id), null);
  await send(dashboard, session.id, 'CREATE'); assert.equal((await read(app, id)).scope, String(project.id));
  await send(dashboard, session.id, 'UPDATE');
  const skill = await read(app, id); assert.equal(skill.scope, String(project.id)); assert.match(skill.prompt_body, /HARNESS_SKILL_BODY_V2/);
  assert.equal((await read(app, foreignId)).prompt_body, 'Foreign instructions stay intact.');
  return { sessionId: session.id, projectId: project.id, passed: true, dryRunPreserved: true, foreignProjectPreserved: true,
    scopePreservedOnUpdate: true, immutableAttemptCatalog: true, createdAt: skill.created_at, updatedAt: skill.updated_at };
}
export async function recoverNativeSkillAuthoringFixture({ app, dashboard, evidence, setSession }) {
  const skill = await read(app, id); assert.equal(skill.created_at, evidence.createdAt); assert.equal(skill.updated_at, evidence.updatedAt);
  setSession(evidence.sessionId); await send(dashboard, evidence.sessionId, 'RECOVER');
  return { passed: true, savedSkillPreserved: true, freshAttemptLoadedNewBody: true };
}
