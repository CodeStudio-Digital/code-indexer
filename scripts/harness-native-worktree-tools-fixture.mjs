import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function nativeWorktreeToolsDelta(body) {
  const start = body.messages.findLastIndex(message => message.role === 'user'
    && /HARNESS_NATIVE_WORKTREE_TOOLS_(KEEP|REMOVE|RESTART)/.test(JSON.stringify(message.content)));
  if (start < 0) return;
  const marker = JSON.stringify(body.messages[start].content).match(/HARNESS_NATIVE_WORKTREE_TOOLS_(KEEP|REMOVE|RESTART)/)[1];
  const results = body.messages.slice(start + 1).filter(message => message.role === 'tool');
  const call = list => ({ role: 'assistant', tool_calls: list.map(([name, args], index) => ({ index,
    id: `workspace-${marker.toLowerCase()}-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  for (const name of ['enter_worktree', 'exit_worktree']) assert(body.tools.some(tool => tool.function?.name === name), `Missing ${name}`);
  if (!results.length) return call([
    ['enter_worktree', { name: 'owned', branch: 'coder/owned' }],
    ['create_file', { path: 'wrong-root.txt', content: 'must not execute' }],
  ]);
  assert.match(results[0].content, /Workspace transition accepted/);
  assert.match(results[1].content, /workspace_transition/);
  if (results.length === 2) return call([
    ['create_file', { path: 'inside.txt', content: 'owned worktree file' }],
    ['exit_worktree', { action: marker === 'REMOVE' ? 'remove' : 'keep', discard_changes: marker === 'REMOVE' }],
    ['create_file', { path: 'too-early.txt', content: 'must not execute' }],
  ]);
  assert.match(results[2].content, /created|written|wrote/i);
  assert.match(results[3].content, /Workspace transition accepted/);
  assert.match(results[4].content, /workspace_transition/);
  if (results.length === 5) return call([['create_file', { path: 'outside.txt', content: 'original project file' }]]);
  assert.equal(results.length, 6);
  assert.match(results[5].content, /created|written|wrote/i);
  return { role: 'assistant', content: `HARNESS_NATIVE_WORKTREE_TOOLS_${marker}_OK` };
}

async function send(dashboard, sessionId, marker, resume = false) {
  return dashboard.evaluate(async ({ sessionId, marker, resume }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/${resume ? 'continue' : 'messages'}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(150000),
      body: JSON.stringify({ ...(resume ? {} : { content: `HARNESS_NATIVE_WORKTREE_TOOLS_${marker}` }),
        client_msg_id: `worktree-tools-${marker}-${resume ? 'resume' : 'start'}`, profile: 'full',
        max_turns: marker === 'RESTART' && !resume ? 1 : 8, max_auto_continues: 0 }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Worktree tools HTTP ${response.status}: ${text.slice(-12000)}`);
    return text;
  }, { sessionId, marker, resume });
}

export async function runNativeWorktreeToolsFixture({ dashboard, post, root, setSession, reopenApplication, requestCount, requestsSince }) {
  const evidence = [];
  for (const marker of ['KEEP', 'REMOVE', 'RESTART']) {
    const projectRoot = join(dirname(root), `native-worktree-tools-${marker.toLowerCase()}`); await mkdir(projectRoot);
    const git = args => execFileSync('git', args, { cwd: projectRoot, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    git(['init', '--initial-branch=main']); await writeFile(join(projectRoot, 'seed.txt'), 'original seed'); git(['add', 'seed.txt']);
    git(['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'fixture']);
    const project = await post('/api/projects', { name: `Native worktree tools ${marker}`, root_path: projectRoot });
    const session = await post('/api/coder/sessions', { project_id: project.id, title: `Native worktree tools ${marker}`,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 8, max_auto_continues: 0 });
    setSession(session.id);
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    const before = requestCount();
    let stream = await send(dashboard, session.id, marker);
    if (marker === 'RESTART') {
      assert.match(stream, /cannot reset an exhausted execution budget/);
      await assert.rejects(access(join(projectRoot, '.mcp-indexer/worktrees/owned')), { code: 'ENOENT' });
      const reopened = await reopenApplication(); dashboard = reopened.dashboard;
      await reopened.app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      setSession(session.id);
      stream += await send(dashboard, session.id, marker, true);
    }
    assert(stream.includes(`HARNESS_NATIVE_WORKTREE_TOOLS_${marker}_OK`), stream.slice(-18000));
    const results = stream.split('\n\n').filter(frame => frame.startsWith('event: tool_call_result\n'))
      .map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
    assert.deepEqual(results.map(result => result.name), ['enter_worktree', 'create_file', 'create_file', 'exit_worktree', 'create_file', 'create_file']);
    assert.deepEqual(results.map(result => result.result.isError === true), [false, true, false, false, true, false]);
    assert.equal(await readFile(join(projectRoot, 'outside.txt'), 'utf8'), 'original project file');
    for (const path of ['wrong-root.txt', 'too-early.txt', 'inside.txt']) await assert.rejects(access(join(projectRoot, path)), { code: 'ENOENT' });
    const worktreeRoot = join(projectRoot, '.mcp-indexer/worktrees/owned');
    if (marker === 'REMOVE') await assert.rejects(access(worktreeRoot), { code: 'ENOENT' });
    else {
      assert.equal(await readFile(join(worktreeRoot, 'inside.txt'), 'utf8'), 'owned worktree file');
      await assert.rejects(access(join(worktreeRoot, 'too-early.txt')), { code: 'ENOENT' });
    }
    assert.equal(git(['branch', '--show-current']).trim(), 'main');
    const history = await dashboard.evaluate(async id => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`);
      if (!response.ok) throw new Error('Worktree history ' + response.status); return response.json();
    }, session.id);
    assert.equal(history.session.worktree_path, null);
    const requests = requestsSince(before);
    assert.equal(requests.length, 4);
    const attempts = new Set(requests.map(request => request.admission.runtimeRoute.attemptId));
    assert.equal(attempts.size, 3);
    assert(requests.every(request => request.admission.runtimeRoute.runtimeGeneration === 'rust_v1'));
    evidence.push({ passed: true, sessionId: session.id, projectRoot: resolve(projectRoot), action: marker,
      attempts: [...attempts], wrongDirectoryCallsRefused: 2, realRestart: marker === 'RESTART' });
  }
  return { passed: true, scenarios: evidence };
}
