import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runCliFixture({ env, repo, isolated, approvalSessionId, setSession, requests, cancelObserved,
  executablePath = join(repo, 'node_modules/electron/dist/electron.exe'), entryPoint = join(repo, 'dist/apps/cli/index.js'), packaged = false }) {
  const signalPreload = join(isolated, 'cli-signal-preload.mjs');
  // Windows kill(SIGINT) terminates a process instead of delivering a console
  // control event. Inject only that event into the real CLI's signal handler.
  await writeFile(signalPreload, "process.on('message', value => { if (value === 'interrupt') process.emit('SIGINT'); }); process.channel?.unref();\n");
  const run = async (scenario, args, expected, approve = false) => {
    setSession(undefined);
    const before = requests.length;
    let stdout = ''; let stderr = ''; let approvalCount = 0; let signalled = false;
    const child = spawn(executablePath,
      ['--import', pathToFileURL(signalPreload).href, entryPoint, 'agent', ...args], {
        cwd: isolated, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
    const interval = setInterval(() => {
      if (scenario === 'CANCEL' && !signalled && cancelObserved()) { signalled = true; child.send('interrupt'); }
    }, 25);
    const timer = setTimeout(() => { child.kill(); }, 90_000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 4 * 1024 * 1024) { child.kill(); return; }
      const session = stdout.match(/\bsession ([a-f0-9-]{36}) \(/)?.[1];
      if (session) setSession(session);
      const prompts = stdout.split('Allow this tool call? [y/N]').length - 1;
      while (approve && approvalCount < prompts) { approvalCount++; child.stdin.write('y\n'); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
    finally { clearTimeout(timer); clearInterval(interval); child.stdin.destroy(); }
    await writeFile(join(isolated, `cli-${scenario.toLowerCase()}.log`), stdout + '\n--- stderr ---\n' + stderr);
    assert.equal(code, expected, `CLI ${scenario}: ${stdout.slice(-3500)}\n${stderr.slice(-3500)}`);
    const sessionId = stdout.match(/\bsession ([a-f0-9-]{36}) \(/)?.[1];
    assert(sessionId, `CLI ${scenario} omitted its session`);
    const calls = requests.slice(before);
    assert(calls.length, `CLI ${scenario} never reached its provider`);
    assert(calls.every(request => request.admission.sessionId === sessionId
      && request.admission.runtimeRoute.runtimeGeneration === 'rust_v1'));
    if (expected === 0) assert(stdout.includes('[done: completed]') && stdout.includes('HARNESS_RESULT_OK'));
    if (approve) assert(approvalCount > 0, 'CLI did not render a keyed tool approval');
    if (scenario === 'CANCEL') assert(signalled && /\[done: (?:cancelled|aborted)\]/.test(stdout));
    return { scenario, sessionId, code, providerRequests: calls.length, approvalCount, signalled, pid: child.pid };
  };
  const common = ['--project', 'Harness fixture', '--provider', 'harness-local', '--model', 'harness-model', '--max-turns', '8'];
  const completed = await run('COMPLETE', [...common, '--agent', 'explore', 'HARNESS_CLI_COMPLETE'], 0);
  const resumed = await run('RESUME', ['--session', completed.sessionId, '--max-turns', '8', 'HARNESS_CLI_RESUME'], 0);
  assert.equal(resumed.sessionId, completed.sessionId);
  const approval = await run('APPROVAL', ['--session', approvalSessionId, '--max-turns', '8', 'HARNESS_APPROVAL_CASE'], 0, true);
  const cancelled = await run('CANCEL', [...common, '--agent', 'explore', 'HARNESS_CLI_CANCEL'], 130);
  const failed = await run('FAILURE', [...common, '--agent', 'explore', 'HARNESS_CLI_FAILURE'], 1);
  return { cases: [completed, resumed, approval, cancelled, failed], signalDelivery: 'IPC-triggered SIGINT handler on Windows',
    runtime: packaged ? 'Packaged Electron executable and ASAR CLI; isolated cwd, no listening port'
      : 'Electron Node ABI for the checkout dependencies; real CLI entry point, no listening port', executablePath, entryPoint };
}
