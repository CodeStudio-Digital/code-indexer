import { expect, test, type Page, type Route } from '@playwright/test';
import type { MasterPrompt } from '@mcp/company-contracts';

const fixture = '/e2e/fixtures/master-prompt.html';
const posted: MasterPrompt = {
  id: '20000000-0000-4000-8000-000000000001',
  company_session_id: '10000000-0000-4000-8000-000000000001',
  agent_run_id: null, kind: 'question', runner_block_id: null, status: 'pending',
  body: 'Como seguimos?', options: [{ label: 'Revisar a pasta', value: 'review' }, { label: 'Continuar', value: 'next' }], allow_freeform: true,
  answer: null, approved: null, feedback: null, created_at: '2026-10-01T12:00:00Z', resolved_at: null,
};

async function openConversation(page: Page, kind: MasterPrompt['kind'], onPost: (route: Route, save: () => MasterPrompt) => Promise<void>) {
  const initial = { ...posted, kind };
  let saved = initial;
  const posts: Record<string, unknown>[] = [];
  let reads = 0;
  let replays = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/state-snapshot')) return route.fulfill({ json: { masterAlive: true, liveOrchestrator: true, masterPrompts: [saved] } });
    if (path.endsWith('/attach')) {
      replays++;
      return route.fulfill({ contentType: 'text/event-stream',
        body: 'event: master_' + kind + '_posted\ndata: ' + JSON.stringify({ prompt: initial }) + '\n\n' });
    }
    if (path.endsWith('/master-prompts/' + posted.id)) {
      reads++;
      return route.fulfill({ json: { prompt: saved } });
    }
    if (path.endsWith('/answer') || path.endsWith('/plan-response')) {
      const body = route.request().postDataJSON();
      posts.push(body);
      return onPost(route, () => {
        saved = { ...initial, status: 'answered', answer: body.answer ?? null,
          approved: body.approved ?? null, feedback: body.feedback ?? null, resolved_at: new Date().toISOString() };
        return saved;
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(fixture);
  await expect(page.getByText(initial.body)).toBeVisible();
  return { posts, reads: () => reads, replays: () => replays };
}

test('shows a typed answer while its POST is still stalled and ignores a replay on reopening', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const api = await openConversation(page, 'question', async (route, save) => {
    save();
    await gate;
    await route.abort().catch(() => {});
  });
  try {
    await page.getByRole('textbox').fill('Veja primeiro os testes.');
    await page.getByRole('textbox').press('Enter');
    await expect(page.getByRole('button', { name: 'Revisar a pasta' })).toBeDisabled();
    await expect(page.getByText('Respondido', { exact: true })).toBeVisible();
    await expect(page.getByText('Veja primeiro os testes.', { exact: false })).toBeVisible();
    expect(api.posts).toEqual([{ prompt_id: posted.id, answer: 'Veja primeiro os testes.' }]);
    expect(api.reads()).toBeGreaterThan(0);
    const before = api.replays();
    release();
    await page.reload();
    await expect.poll(api.replays).toBeGreaterThan(before);
    await expect(page.getByText('Respondido', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    expect(api.posts).toHaveLength(1);
  } finally { release(); }
});

test('shows a confirmed choice immediately from the POST without waiting for an SSE event', async ({ page }) => {
  const api = await openConversation(page, 'question', (route, save) =>
    route.fulfill({ json: { ok: true, prompt: save() } }));
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByText('Respondido', { exact: true })).toBeVisible();
  await expect(page.getByText(/›.*Continuar/)).toBeVisible();
  expect(api.posts).toEqual([{ prompt_id: posted.id, answer: 'next' }]);
  expect(api.reads()).toBe(0);
});

test('reconciles a chosen option after a duplicate conflict without redelivering', async ({ page }) => {
  const api = await openConversation(page, 'question', async (route, save) => {
    save();
    await route.fulfill({ status: 409, json: { code: 'PROMPT_ALREADY_RESOLVED' } });
  });
  await page.getByRole('button', { name: 'Revisar a pasta' }).click();
  await expect(page.getByText('Respondido', { exact: true })).toBeVisible();
  await expect(page.getByText(/›.*Revisar a pasta/)).toBeVisible();
  expect(api.posts).toEqual([{ prompt_id: posted.id, answer: 'review' }]);
});

test('keeps rejected input editable and sends again only on a new click', async ({ page }) => {
  let refuse = true;
  const api = await openConversation(page, 'question', async (route, save) => {
    if (refuse) return route.fulfill({ status: 409, json: { code: 'MASTER_INPUT_NOT_ACCEPTED' } });
    save();
    await route.abort();
  });
  await page.getByRole('textbox').fill('Meu comentário.');
  await page.getByRole('button', { name: 'Responder' }).click();
  await expect(page.getByRole('alert')).toContainText('O Master não aceitou');
  await expect(page.getByRole('textbox')).toHaveValue('Meu comentário.');
  await expect(page.getByRole('button', { name: 'Responder' })).toBeEnabled();
  expect(api.posts).toHaveLength(1);
  refuse = false;
  await page.getByRole('button', { name: 'Responder' }).click();
  await expect(page.getByText('Respondido', { exact: true })).toBeVisible();
  expect(api.posts).toHaveLength(2);
});

test('shows the saved plan decision and feedback if the POST acknowledgement is lost', async ({ page }) => {
  const api = await openConversation(page, 'plan', async (route, save) => { save(); await route.abort(); });
  await page.getByRole('textbox').fill('Revise os testes.');
  await page.getByRole('button', { name: 'Rejeitar' }).click();
  await expect(page.getByText('Respondido', { exact: true })).toBeVisible();
  await expect(page.getByText(/Revise os testes/)).toBeVisible();
  expect(api.posts).toEqual([{ prompt_id: posted.id, approved: false, feedback: 'Revise os testes.' }]);
});

test('releases the card when both the acknowledgement and a saved answer are missing', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const api = await openConversation(page, 'question', async (route) => {
    await gate;
    await route.abort().catch(() => {});
  });
  try {
    await page.getByRole('textbox').fill('Manter esta resposta.');
    await page.getByRole('button', { name: 'Responder' }).click();
    await expect(page.getByRole('alert')).toContainText('Não foi possível confirmar', { timeout: 17_000 });
    await expect(page.getByRole('textbox')).toHaveValue('Manter esta resposta.');
    await expect(page.getByRole('button', { name: 'Responder' })).toBeEnabled();
    expect(api.posts).toHaveLength(1);
  } finally { release(); }
});

test('asks before retrying an uncertain delivery and keeps the draft when declined', async ({ page }) => {
  const api = await openConversation(page, 'question', (route) =>
    route.fulfill({ status: 500, json: { code: 'OUTCOME_UNKNOWN' } }));
  await page.getByRole('textbox').fill('Verifique os arquivos.');
  await page.getByRole('button', { name: 'Responder' }).click();
  await page.getByRole('button', { name: 'Manter pendente' }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível confirmar');
  await expect(page.getByRole('textbox')).toHaveValue('Verifique os arquivos.');
  expect(api.posts).toHaveLength(1);
});
