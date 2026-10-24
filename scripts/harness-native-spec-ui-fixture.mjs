import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Exercise the real review card, including an undelivered response and double click. */
export async function runNativeSpecUiFixture({ dashboard, post, root, output, setSession }) {
  const originalUrl = dashboard.url();
  const projectRoot = join(dirname(root), 'spec-ui'); await mkdir(projectRoot, { recursive: true });
  const project = await post('/api/projects', { name: 'Specification UI fixture', root_path: projectRoot });
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Specification UI fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'spec', max_turns: 8 });
  setSession(session.id);
  await dashboard.goto(originalUrl.split('#')[0] + `#/projects/${project.id}?session=${session.id}`);
  await dashboard.locator('textarea').last().fill('HARNESS_NATIVE_SPEC_COMPLETE');
  await dashboard.evaluate(id => {
    const original = window.fetch.bind(window); window.harnessSpecResponses = [];
    let injected = false;
    window.harnessSpecUiStream = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Specification UI stream timed out')), 120000);
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (url.includes(`/sessions/${id}/spec-response`) && args[1]?.method === 'POST') {
          const body = JSON.parse(args[1].body); window.harnessSpecResponses.push(body);
          await new Promise(r => setTimeout(r, 200));
          if (body.approved && !injected) {
            injected = true;
            return new Response(JSON.stringify({ error: 'SPEC_UI_RETRY_FIXTURE' }), {
              status: 503, headers: { 'Content-Type': 'application/json' } });
          }
        }
        const response = await original(...args);
        if (url.includes(`/sessions/${id}/messages`) && args[1]?.method === 'POST') {
          void response.clone().text().then(text => { clearTimeout(timer); resolve({ text, status: response.status }); }, reject);
        }
        return response;
      };
    });
    void window.harnessSpecUiStream.catch(() => {});
  }, session.id);
  await dashboard.getByRole('button', { name: 'Enviar', exact: true }).click({ timeout: 30000 });
  const feedback = dashboard.getByPlaceholder('O que precisa mudar? (opcional ao aprovar)', { exact: true }).last();
  await feedback.fill('Add restart verification', { timeout: 30000 });
  await dashboard.getByRole('button', { name: 'Solicitar mudanças', exact: true }).last().click();
  await dashboard.getByRole('heading', { name: 'Acceptance Criteria', exact: true }).last().waitFor({ timeout: 30000 });
  const approve = dashboard.getByRole('button', { name: 'Aprovar', exact: true }).last();
  await approve.click();
  await dashboard.getByRole('alert').filter({ hasText: 'SPEC_UI_RETRY_FIXTURE' }).waitFor({ timeout: 15000 });
  await approve.evaluate(button => { button.click(); button.click(); });
  const result = await dashboard.evaluate(() => window.harnessSpecUiStream);
  assert.equal(result.status, 200); assert(result.text.includes('HARNESS_NATIVE_SPEC_COMPLETE_OK'));
  assert(!/event: error\r?\n/.test(result.text));
  const replies = await dashboard.evaluate(() => window.harnessSpecResponses);
  assert.equal(replies.length, 3, 'duplicate click sent a duplicate response');
  assert.equal(replies[0].approved, false); assert.equal(replies[0].requested_changes, 'Add restart verification');
  assert.equal(replies[1].approved, true); assert.equal(replies[2].approved, true);
  assert.match(replies[0].interaction_id, /^native-tool:/); assert.notEqual(replies[0].interaction_id, replies[1].interaction_id);
  assert.equal(replies[1].interaction_id, replies[2].interaction_id);
  assert.equal((await readdir(join(projectRoot, '.mcp/specs'))).length, 2);
  await assert.rejects(access(join(projectRoot, 'blocked-spec.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(projectRoot, 'approved-spec.txt'), 'utf8'), 'SPEC_APPROVED_WRITE');
  assert(!(await dashboard.locator('body').innerText()).includes('<system-reminder>'), 'internal reminder leaked into live chat');
  await dashboard.reload();
  await dashboard.getByText('HARNESS_NATIVE_SPEC_COMPLETE_OK', { exact: true }).waitFor({ timeout: 30000 });
  assert(!(await dashboard.locator('body').innerText()).includes('<system-reminder>'), 'internal reminder leaked after reload');
  await dashboard.screenshot({ path: join(output, 'native-spec-review-ui.png') });
  await dashboard.goto(originalUrl);
  return { sessionId: session.id, composer: true, rejectedViaUi: true, approvedViaUi: true,
    undeliveredResponseRetry: true, duplicateClickSuppressed: true, internalReminderHidden: true, responses: replies.length };
}
