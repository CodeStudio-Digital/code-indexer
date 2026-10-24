import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export function legacyWorktreeDelta(body) {
  const start = body.messages.findLastIndex(message => message.role === 'user' && /HARNESS_LEGACY_WORKTREE_(READY|FOLLOWUP)/.test(JSON.stringify(message.content)));
  if (start < 0) return;
  const stage = JSON.stringify(body.messages[start].content).includes('FOLLOWUP') ? 'FOLLOWUP' : 'READY';
  const results = body.messages.slice(start + 1).filter(message => message.role === 'tool');
  if (!results.length) return { role: 'assistant', tool_calls: [{ index: 0, id: `legacy-worktree-${stage}`,
    type: 'function', function: { name: stage === 'READY' ? 'create_file' : 'read_file',
      arguments: JSON.stringify(stage === 'READY' ? { path: 'worktree-only.txt', content: 'isolated-marker' } : { path: 'worktree-only.txt' }) } }] };
  assert.equal(results.length, 1);
  if (stage === 'FOLLOWUP') assert.match(results[0].content, /isolated-marker/);
  return { role: 'assistant', content: `HARNESS_LEGACY_WORKTREE_${stage}_OK` };
}

export async function runLegacyWorktreeFixture({ dashboard, post, root, setSession, requestCount, requestsSince }) {
  const setup = async (path, title) => {
    const project = await post('/api/projects', { name: title, root_path: path });
    const session = await post('/api/coder/sessions', { project_id: project.id, title,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    setSession(session.id); return session.id;
  };
  const send = (sessionId, stage, worktree) => dashboard.evaluate(async ({ sessionId, stage, worktree }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ content: `HARNESS_LEGACY_WORKTREE_${stage}`, profile: 'full', worktree, max_turns: 3 }) });
    return { status: response.status, text: await response.text() };
  }, { sessionId, stage, worktree });

  const invalidRoot = join(dirname(root), 'legacy-worktree-not-git'); await mkdir(invalidRoot);
  const rejected = await setup(invalidRoot, 'Legacy worktree rejected'); const before = requestCount();
  const failure = await send(rejected, 'REJECT', { name: 'requested-isolation' });
  assert.match(failure.text, /Requested session worktree could not be prepared/);
  assert.equal(requestCount(), before, 'failed worktree silently called the provider on the main directory');

  const projectRoot = join(dirname(root), 'legacy-worktree-git'); await mkdir(projectRoot);
  const git = args => promisify(execFile)('git', args, { cwd: projectRoot, windowsHide: true, timeout: 10_000 });
  await git(['init', '--initial-branch=main']); await git(['config', 'core.autocrlf', 'false']);
  await writeFile(join(projectRoot, 'seed.txt'), 'seed\n'); await git(['add', 'seed.txt']);
  await git(['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'fixture']);
  const sessionId = await setup(projectRoot, 'Legacy async worktree');
  const first = await send(sessionId, 'READY', { name: 'async', branch: 'codex/async' });
  assert.equal(first.status, 200); assert(!/event: error\r?\n/.test(first.text));
  assert.match(first.text, /HARNESS_LEGACY_WORKTREE_READY_OK/);
  const worktreeRoot = join(projectRoot, '.mcp-indexer/worktrees/async');
  assert.equal(await readFile(join(worktreeRoot, 'worktree-only.txt'), 'utf8'), 'isolated-marker');
  await assert.rejects(readFile(join(projectRoot, 'worktree-only.txt')), { code: 'ENOENT' });
  const followup = await send(sessionId, 'FOLLOWUP');
  assert.equal(followup.status, 200); assert(!/event: error\r?\n/.test(followup.text));
  assert.match(followup.text, /HARNESS_LEGACY_WORKTREE_FOLLOWUP_OK/);
  const detail = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}?full=1`)).json(), sessionId);
  assert.equal(resolve(detail.session.worktree_path), worktreeRoot);
  assert.equal((await git(['branch', '--show-current'])).stdout.trim(), 'main');
  assert.equal(requestCount() - before, 5);
  assert.equal(requestsSince(before).filter(request => request.verificationReminder).length, 1,
    'one extra provider request must be the legacy verification reminder, not a replay');
  return { rejectedSessionId: rejected, rejectedBeforeProvider: true, sessionId, root: worktreeRoot,
    originalUnchanged: true, persisted: true, reopened: true, providerRequests: 5, verificationReminders: 1 };
}
