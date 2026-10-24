import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function preparePersistentCommandFixture(root) {
  await writeFile(join(root, 'persistent.cjs'), `
const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore',windowsHide:true});
require('fs').writeFileSync('persistent-pids.json', JSON.stringify([process.pid,child.pid]));
console.error('HARNESS_PERSISTENT_PROMPT');
console.log('PERSISTENT_TTY:' + Boolean(process.stdin.isTTY) + ':' + Boolean(process.stdout.isTTY) + ':' + process.stdout.columns + ':' + process.stdout.rows);
require('readline').createInterface({input:process.stdin}).on('line', value => {
  console.log('PERSISTENT_ACK:' + value); if(value === 'exit') process.exit(0);
});
`);
}

export function persistentCommandDelta(body, toolMessages, tty = false) {
  if (!body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_PERSISTENT_CASE'))) return undefined;
  const call = (name, input) => ({ role: 'assistant', tool_calls: [{ index: 0, id: `harness-persistent-${toolMessages.length}`, type: 'function',
    function: { name, arguments: JSON.stringify(input) } }] });
  if (!toolMessages.length) return call('exec_command', { cmd: 'node persistent.cjs', yield_time_ms: 2000,
    ...(tty ? { tty: true, cols: 100, rows: 32 } : {}) });
  const first = JSON.stringify(toolMessages[0].content);
  assert(first.includes('HARNESS_PERSISTENT_PROMPT'), 'stderr prompt did not arrive while process was running');
  assert(first.includes(tty ? 'PERSISTENT_TTY:true:true:100:32' : 'PERSISTENT_TTY:false:false'), 'terminal mode or geometry did not reach the command');
  const sessionId = /session_id=(\w+)/.exec(first)?.[1]; assert(sessionId, 'persistent session identity missing');
  if (toolMessages.length === 1) return call('write_stdin', { session_id: sessionId, chars: tty ? 'hello\r' : 'hello\n', yield_time_ms: 250 });
  assert(JSON.stringify(toolMessages[1].content).includes('PERSISTENT_ACK:hello'), 'stdin did not reach the same process');
  if (toolMessages.length === 2) return call('write_stdin', { session_id: sessionId, chars: tty ? 'exit\r' : 'exit\n', yield_time_ms: 2000 });
  assert.equal(toolMessages.length, 3, 'persistent tool input was repeated');
  assert(JSON.stringify(toolMessages[2].content).includes('status=exited exit=0'), 'command exit was not physically confirmed');
  return { role: 'assistant', content: 'HARNESS_PERSISTENT_COMPLETE' };
}

export async function runPersistentCommandFixture({ root, dashboard, post, projectId, setSession, requestCount, tty = false }) {
  const session = await post('/api/coder/sessions', { project_id: projectId, title: 'Persistent command fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 5 });
  setSession(session.id);
  await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'ask' }, 'PATCH');
  const before = requestCount();
  await dashboard.exposeFunction('harnessBeforePersistentSpawn', async () => {
    await assert.rejects(readFile(join(root, 'persistent-pids.json')), { code: 'ENOENT' }, 'spawn happened before approval');
  });
  const result = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ content: 'HARNESS_PERSISTENT_CASE', profile: 'full', client_msg_id: 'persistent-one', max_turns: 5 }) });
    if (!response.ok || !response.body) throw new Error(`persistent command run ${response.status}: ${await response.text()}`);
    let stream = ''; let buffer = ''; const approved = [];
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      const text = decoder.decode(next.value, { stream: true }); stream += text; buffer += text;
      const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (!/^event: tool_approval_request$/m.test(frame)) continue;
        const data = JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'));
        const expected = approved.length === 0 ? 'exec_command' : 'write_stdin';
        if (data.toolName !== expected || approved.length >= 3) throw new Error('Unexpected persistent command approval');
        if (!approved.length) await window.harnessBeforePersistentSpawn();
        const approval = await fetch(`mcp://app/api/coder/sessions/${id}/tool-approval`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }) });
        if (!approval.ok) throw new Error(`persistent approval ${approval.status}`);
        approved.push(data.toolUseId);
      }
    }
    return { stream, approved };
  }, session.id);
  assert(result.stream.includes('HARNESS_PERSISTENT_COMPLETE')); assert.equal(result.approved.length, 3);
  assert.equal(requestCount() - before, 4, 'unexpected persistent provider replay');
  const pids = JSON.parse(await readFile(join(root, 'persistent-pids.json'), 'utf8'));
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'persistent process survived the attempt');
  return { sessionId: session.id, approvals: 3, providerCalls: 4, liveStderr: true, stdinAcrossTurns: true, tty, reapedPids: pids };
}
