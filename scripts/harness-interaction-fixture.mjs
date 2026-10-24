import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function interactionDelta(body, toolMessages) {
  const scenario = JSON.stringify(body.messages.filter(message => message.role === 'user'))
    .match(/HARNESS_REVIEW_(QUESTION|DECISION|APPROVE|REVISE|CANCEL)/)?.[1];
  if (!scenario) return undefined;
  const plan = scenario === 'APPROVE' || scenario === 'REVISE';
  if (toolMessages.length) {
    assert.notEqual(scenario, 'CANCEL', 'cancelled question resumed its provider');
    const text = JSON.stringify(toolMessages);
    assert(text.includes(plan ? scenario === 'APPROVE' ? 'Plan approved by user' : 'Plan revision requested by user'
      : scenario === 'DECISION' ? 'scope: Fixture B' : 'User answered: option_b'), 'review lost its user response');
    if (plan) assert.equal(toolMessages.length, 3, 'plan barrier lost a tool result');
    return { role: 'assistant', content: `HARNESS_REVIEW_OK_${scenario}` };
  }
  const options = [{ label: 'Fixture A', value: 'option_a', summary: 'First scope' },
    { label: 'Fixture B', value: 'option_b', summary: 'Second scope' }];
  const review = plan ? ['submit_plan', { plan: `Fixture plan ${scenario}: create only review-${scenario}-after.txt after approval.` }]
    : scenario === 'DECISION' ? ['decision_gate', { questions: [{ id: 'scope', question: 'Fixture decision scope?', options }] }]
      : ['ask_user', { question: `Fixture question ${scenario}?`, options }];
  const calls = plan ? [
    ['create_file', { path: `review-${scenario}-before.txt`, content: 'forbidden' }], review,
    ['create_file', { path: `review-${scenario}-after.txt`, content: 'approved' }],
  ] : [review];
  return { role: 'assistant', tool_calls: calls.map(([name, input], index) => ({ index,
    id: `harness-review-${scenario}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(input) } })) };
}

export async function runInteractionFixture({ dashboard, post, projectId, root, setSession, requestCount }) {
  const cases = [];
  for (const scenario of ['QUESTION', 'DECISION', 'APPROVE', 'REVISE', 'CANCEL']) {
    const plan = scenario === 'APPROVE' || scenario === 'REVISE';
    const session = await post('/api/coder/sessions', { project_id: projectId, title: `Review ${scenario}`,
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 4 });
    setSession(session.id);
    await post(`/api/coder/sessions/${session.id}/tool-permission-mode`, { mode: 'unrestricted' }, 'PATCH');
    await dashboard.goto(dashboard.url().split('#')[0] + `#/projects/${projectId}?session=${session.id}`);
    await dashboard.reload();
    await dashboard.getByText('Harness local fixture · harness-model', { exact: true }).waitFor({ timeout: 60_000 });
    await dashboard.evaluate(({ id, plan }) => {
      const original = window.fetch.bind(window);
      window.fetch = (url, init) => {
        if (String(url).includes(`/sessions/${id}/messages`) && init?.method === 'POST') {
          init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), profile: 'full', plan_mode: plan }) };
        }
        return original(url, init);
      };
    }, { id: session.id, plan });
    const before = requestCount();
    await dashboard.locator('textarea').last().fill(`HARNESS_REVIEW_${scenario}`);
    await dashboard.getByRole('button', { name: 'Enviar', exact: true }).click();
    const cardText = plan ? `Fixture plan ${scenario}: create only review-${scenario}-after.txt after approval.`
      : scenario === 'DECISION' ? 'Fixture decision scope?' : `Fixture question ${scenario}?`;
    await dashboard.getByText(cardText, { exact: true }).last().waitFor({ timeout: 60_000 });
    assert(!existsSync(join(root, `review-${scenario}-before.txt`)));
    assert(!existsSync(join(root, `review-${scenario}-after.txt`)));
    // An unrelated response must not consume the pending human-response slot.
    const rejected = await dashboard.evaluate(async id => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/answer`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'wrong', interaction_id: 'native-tool:wrong' }) });
      return { status: response.status, body: await response.json() };
    }, session.id);
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'INTERACTION_NOT_PENDING');
    const reloaded = scenario === 'QUESTION' || scenario === 'DECISION' || scenario === 'REVISE';
    if (reloaded) {
      await dashboard.reload();
      await dashboard.getByText(cardText, { exact: true }).last().waitFor({ timeout: 60_000 });
    }
    if (scenario === 'CANCEL') await post(`/api/coder/sessions/${session.id}/abort`, {});
    else {
      // Fail one transport response before it reaches the server. The card must
      // retain its draft, show the failure and accept a retry with the same ID.
      await dashboard.evaluate(({ id, endpoint }) => {
        const original = window.fetch.bind(window); let failed = false;
        window.harnessReviewPosts = [];
        window.fetch = (url, init) => {
          if (String(url).includes(`/sessions/${id}/${endpoint}`) && init?.method === 'POST') {
            window.harnessReviewPosts.push(JSON.parse(init.body));
            if (!failed) { failed = true; return Promise.resolve(new Response(JSON.stringify({ error: 'HARNESS_RESPONSE_RETRY' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } })); }
          }
          return original(url, init);
        };
      }, { id: session.id, endpoint: plan ? 'plan-response' : scenario === 'DECISION' ? 'decide' : 'answer' });
      let submit;
      if (plan) {
        const feedback = dashboard.getByPlaceholder('Feedback opcional…');
        if (scenario === 'REVISE') await feedback.fill('Use the smaller scope.');
        submit = () => feedback.locator('..').getByRole('button', { name: scenario === 'APPROVE' ? 'Aprovar' : 'Revisar', exact: true }).click();
      } else {
        const option = dashboard.getByRole('button', { name: /Fixture B/ }).last();
        if (scenario === 'DECISION') {
          await option.click();
          submit = () => dashboard.getByRole('button', { name: 'Confirmar decisões', exact: true }).click();
        } else submit = () => option.click();
      }
      await submit();
      await dashboard.getByRole('alert').filter({ hasText: 'HARNESS_RESPONSE_RETRY' }).waitFor();
      assert(!existsSync(join(root, `review-${scenario}-after.txt`)), 'unacknowledged approval released a write');
      await submit();
      const posts = await dashboard.evaluate(() => window.harnessReviewPosts);
      assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]);
      assert.match(posts[0].interaction_id, /^native-tool:/);
    }
    const outcome = await dashboard.evaluate(async ({ id, scenario }) => {
      const deadline = Date.now() + 60_000;
      let history;
      while (Date.now() < deadline) {
        const response = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`);
        if (!response.ok) throw new Error(`review history ${response.status}`);
        history = await response.json();
        if (history.runtime_outcome && history.runtime_outcome.status !== 'running') return history;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`review ${scenario} did not settle: ${JSON.stringify(history?.runtime_outcome)}`);
    }, { id: session.id, scenario });
    assert.equal(outcome.runtime_outcome.status, scenario === 'CANCEL' ? 'cancelled' : 'completed');
    if (scenario !== 'CANCEL') assert(JSON.stringify(outcome.messages).includes(`HARNESS_REVIEW_OK_${scenario}`));
    assert(!existsSync(join(root, `review-${scenario}-before.txt`)), 'plan allowed a write before approval');
    assert.equal(existsSync(join(root, `review-${scenario}-after.txt`)), scenario === 'APPROVE');
    assert.equal(requestCount() - before, scenario === 'CANCEL' ? 1 : 2);
    cases.push({ scenario, sessionId: session.id, reloaded, wrongIdentityRejected: true, responseRetry: scenario !== 'CANCEL',
      status: outcome.runtime_outcome.status, providerRequests: requestCount() - before });
  }
  return { cases, input: 'real dashboard cards and HTTP facade', planBarrier: 'writes before and after verdict' };
}
