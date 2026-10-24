import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function nativeOutputDelta(body, results) {
  const prompt = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1));
  const scenario = prompt.match(/HARNESS_NATIVE_OUTPUT_(COMPLETE|RECOVER)/)?.[1];
  if (!scenario) return;
  const recoveryCallId = `harness-output-recovery-${scenario}`;
  const call = (name, args) => ({ role: 'assistant', tool_calls: [{ index: 0, id: recoveryCallId,
    type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  assert(body.tools.some(tool => tool.function?.name === 'get_tool_output'), 'missing output recovery capability');
  const recovered = results.find(result => result.tool_call_id === recoveryCallId);
  if (recovered) {
    assert(JSON.stringify(recovered.content).includes('RECOVERED_MIDDLE_EVIDENCE'), JSON.stringify(recovered.content));
    return { role: 'assistant', content: `HARNESS_NATIVE_OUTPUT_${scenario}_OK` };
  }
  if (scenario === 'RECOVER') {
    // The caller retains the durable handle. A new compacted frontier need not
    // include the nine original tool messages to recover their journal bytes.
    const id = prompt.match(/output_id=([a-f0-9]{64})/)?.[1];
    assert(id, 'restart recovery must receive the previously captured durable output ID');
    return call('get_tool_output', { output_id: id, offset: 99950, limit: 500 });
  }
  if (!results.length) return { role: 'assistant', tool_calls: Array.from({ length: 9 }, (_, index) => ({
    index, id: `harness-output-read-${index}`, type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: `large-result-${index}.txt` }) },
  })) };
  const ids = Array.from({ length: 9 }, (_, index) => {
    const result = results.find(result => result.tool_call_id === `harness-output-read-${index}`);
    const id = (JSON.stringify(result?.content) ?? '').match(/output_id=([a-f0-9]{64})/)?.[1];
    assert(id, `large native output ${index} did not return a durable recovery ID`);
    return id;
  });
  assert(Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024, 'provider request must cross the single Data frame ceiling');
  return call('get_tool_output', { output_id: ids[0], offset: 99950, limit: 500 });
}

async function command(dashboard, sessionId, scenario, outputId) {
  const result = await dashboard.evaluate(async ({ id, scenario, outputId }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ content: `HARNESS_NATIVE_OUTPUT_${scenario}${outputId ? ` output_id=${outputId}` : ''}`,
        profile: 'full', max_turns: 5 }) });
    return { status: response.status, stream: await response.text() };
  }, { id: sessionId, scenario, outputId });
  assert.equal(result.status, 200);
  assert(result.stream.includes(`HARNESS_NATIVE_OUTPUT_${scenario}_OK`), result.stream.slice(-5000));
  const toolResults = result.stream.split(/\r?\n\r?\n/).filter(event => event.startsWith('event: tool_call_result\n')
    || event.startsWith('event: tool_call_result\r\n')).map(event =>
    JSON.parse(event.split(/\r?\n/).find(line => line.startsWith('data: ')).slice(6)));
  const reads = toolResults.filter(result => result.name === 'read_file');
  assert.equal(reads.length, scenario === 'COMPLETE' ? 9 : 0, 'restart must not reread the replaced source files');
  const outputIds = reads.map(result => {
    const id = JSON.stringify(result.result.content).match(/output_id=([a-f0-9]{64})/)?.[1];
    assert(id, 'stream lost a durable output ID');
    return id;
  });
  const recovered = toolResults.filter(result => result.name === 'get_tool_output');
  assert.equal(recovered.length, 1);
  assert(JSON.stringify(recovered[0].result.content).includes('RECOVERED_MIDDLE_EVIDENCE'));
  return { resultConfirmed: true, streamCharacters: result.stream.length, outputIds,
    recoveredFromJournal: true, sourceReadCount: reads.length };
}

export async function runNativeOutputFixture({ root, dashboard, post, setSession }) {
  const projectRoot = join(dirname(root), 'output-recovery'); await mkdir(projectRoot);
  const files = Array.from({ length: 9 }, (_, index) => join(projectRoot, `large-result-${index}.txt`));
  await Promise.all(files.map(file => writeFile(file, 'x'.repeat(100000) + 'RECOVERED_MIDDLE_EVIDENCE' + 'z'.repeat(180000))));
  const project = await post('/api/projects', { name: 'Native output recovery', root_path: projectRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native output recovery',
    provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 5 });
  setSession(session.id);
  const completed = await command(dashboard, session.id, 'COMPLETE');
  // Deliberately change only this fixture. Recovery must use journal bytes.
  await Promise.all(files.map(file => writeFile(file, 'SOURCE_REPLACED_AFTER_CAPTURE')));
  return { sessionId: session.id, root: projectRoot, ...completed, sourceChangedAfterCapture: true, largeReadCount: files.length,
    providerRequestExceedsDataFrame: true };
}

export async function recoverNativeOutputFixture({ dashboard, setSession, evidence }) {
  setSession(evidence.sessionId);
  assert.equal(evidence.outputIds.length, 9);
  return command(dashboard, evidence.sessionId, 'RECOVER', evidence.outputIds[0]);
}
