import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const initial = '<mxfile><diagram name="One"><mxGraphModel><root/></mxGraphModel></diagram><diagram name="Two"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
const updated = '<mxGraphModel><root><mxCell id="marker" value="UPDATED &amp; preserved" vertex="1" parent="1"><mxGeometry x="20" y="20" width="240" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
export function nativeDiagramsDelta(body, exports = false) {
  const start = body.messages.findLastIndex(m => m.role === 'user' && /HARNESS_NATIVE_DIAGRAMS/.test(JSON.stringify(m.content)));
  if (start < 0) return;
  for (const name of ['diagram_create', 'diagram_update', 'diagram_read', 'diagram_list']) assert(body.tools.some(t => t.function?.name === name));
  const results = body.messages.slice(start + 1).filter(m => m.role === 'tool');
  const call = calls => ({ role: 'assistant', tool_calls: calls.map(([name, args], index) => ({ index,
    id: `harness-diagram-${results.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
  const text = n => results[n].content;
  const json = n => JSON.parse(text(n).slice(text(n).indexOf('{'), text(n).lastIndexOf('}') + 1));
  if (!results.length) return call([['diagram_create', { name: 'Harness flow', xml: initial }], ['diagram_list', { limit: 2, format: 'json' }]]);
  if (results.length === 2) {
    assert.match(text(0), /Created diagrams\/harness-flow.drawio/); assert.equal(json(1).next_offset, 2);
    return call([['diagram_create', { name: 'Harness flow', xml: updated }], ['diagram_update', { name: 'Harness flow', xml: updated }], ['diagram_read', { name: 'Harness flow' }]]);
  }
  if (results.length === 5) {
    assert.match(text(2), /already exists/); assert.match(text(3), /Updated/);
    assert.match(text(4), /UPDATED &amp; preserved/); assert.match(text(4), /id="0"/); assert.match(text(4), /id="1"/);
    return call([['diagram_create', { name: 'broken', xml: '<mxGraphModel><root>' }], ['diagram_read', { name: 'missing' }],
      ['diagram_list', { offset: 2, limit: 2, format: 'json' }], ['diagram_update', { name: 'missing', xml: updated }]]);
  }
  if (results.length === 11 && exports) {
    assert.match(text(9), /Exported diagrams\/harness-flow.svg/); assert.match(text(10), /Exported diagrams\/harness-flow.png/);
    return call([['diagram_export', { name: 'Harness flow', format: 'svg' }], ['diagram_export', { name: 'Harness flow', format: 'png', output_name: 'alternate' }]]);
  }
  if (results.length === 13 && exports) {
    assert.match(text(11), /already exists/); assert.match(text(12), /Exported diagrams\/alternate.png/);
    return { role: 'assistant', content: 'HARNESS_NATIVE_DIAGRAMS_OK' };
  }
  assert.equal(results.length, 9); assert.match(text(5), /Invalid diagram XML/); assert.match(text(6), /No diagram/);
  assert.equal(json(7).names.length, 2); assert.equal(json(7).next_offset, null); assert.match(text(8), /No diagram/);
  if (exports) return call([['diagram_export', { name: 'Harness flow', format: 'svg' }], ['diagram_export', { name: 'Harness flow', format: 'png' }]]);
  return { role: 'assistant', content: 'HARNESS_NATIVE_DIAGRAMS_OK' };
}

export async function runNativeDiagramsFixture({ app, root, dashboard, post, setSession, exports = false }) {
  const caseRoot = join(dirname(root), 'diagram-tools'); await mkdir(join(caseRoot, 'diagrams'), { recursive: true });
  await Promise.all(['a', 'b', 'c'].map(name => writeFile(join(caseRoot, `diagrams/${name}.drawio`), initial)));
  const project = await post('/api/projects', { name: 'Native diagrams', root_path: caseRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Native diagram CRUD',
    provider: 'harness-local', model: 'harness-model', agent: 'diagram', max_turns: 8 }); setSession(session.id);
  const stream = await dashboard.evaluate(async id => {
    const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180000), body: JSON.stringify({ content: 'HARNESS_NATIVE_DIAGRAMS', profile: 'full', max_turns: 8 }) });
    if (!response.ok) throw new Error('Diagram fixture ' + response.status); return response.text();
  }, session.id);
  assert(stream.includes('HARNESS_NATIVE_DIAGRAMS_OK'), stream.slice(-7000));
  assert.equal((stream.match(/event: diagram_changed/g) ?? []).length, 2, 'only committed writes notify the renderer');
  assert.match(await readFile(join(caseRoot, 'diagrams/harness-flow.drawio'), 'utf8'), /UPDATED &amp; preserved/);
  await assert.rejects(access(join(caseRoot, 'diagrams/broken.drawio')));
  let cancelledRenders = 0;
  if (exports) {
    assert.match(await readFile(join(caseRoot, 'diagrams/harness-flow.svg'), 'utf8'), /UPDATED/);
    for (const name of ['harness-flow', 'alternate']) {
      const png = await readFile(join(caseRoot, `diagrams/${name}.png`));
      assert.equal(png.subarray(1,4).toString(), 'PNG');
      assert(png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= 2048);
      assert(png.readUInt32BE(20) > 0 && png.readUInt32BE(20) <= 2048);
    }
    cancelledRenders = await app.evaluate(async ({ app, BrowserWindow }, xml) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { getDiagramRenderer } = require(join(app.getAppPath(), 'dist/packages/code-agent/src/tools/diagram/render-port.js'));
      let count = 0;
      for (const delay of [0, 10, 50, 200]) {
        const before = new Set(BrowserWindow.getAllWindows().map(win => win.id)), stop = new AbortController();
        const pending = getDiagramRenderer().render({ requestId: `cancel-${delay}`, xml, format: 'png' }, stop.signal);
        const owned = BrowserWindow.getAllWindows().filter(win => !before.has(win.id));
        const timer = setTimeout(() => stop.abort(new Error('fixture cancelled')), delay);
        try { await pending; throw new Error('Cancelled diagram unexpectedly completed'); }
        catch (error) { if (!stop.signal.aborted) throw error; }
        finally { clearTimeout(timer); }
        if (owned.length !== 1 || owned.some(win => !win.isDestroyed())) throw new Error('Diagram cancellation left an owned window open');
        count++;
      }
      return count;
    }, updated);
  }
  return { sessionId: session.id, passed: true, exclusiveCreation: true, updateAndRead: true, paginatedListing: true,
    malformedXmlRejected: true, committedChangeEvents: 2, rendererNotificationTransport: true, offlineImageExports: exports, cancelledRenders };
}
