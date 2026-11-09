import { expect, test } from '@playwright/test';
import { collaborationData, collaborationPolicy } from './fixtures/collaboration-data.js';

test('mentions chats/projects and prepares five independent roles/models with a visible completion trigger', async ({ page }) => {
  test.setTimeout(60_000);
  const id = '11111111-1111-4111-8111-111111111111', peerId = '22222222-2222-4222-8222-222222222222';
  const failures: string[] = [], references: any[] = [], teams: any[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => localStorage.setItem('i18n-lang', 'pt-BR'));
  const data = collaborationData(id), config = data.config;
  data.candidates = [{ id: peerId, title: 'Revisão existente' }];
  data.chats[0]!.title = 'Planejar feature';
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    const body = method === 'POST' || method === 'PUT' ? route.request().postDataJSON() : null;
    if (path.endsWith('/collaboration/policy')) return route.fulfill({ json: collaborationPolicy() });
    if (path.endsWith('/collaboration/settings')) { if (body) Object.assign(config, body); return route.fulfill({ json: config }); }
    if (path.endsWith('/collaboration/suggestions')) return route.fulfill({ json: { items: url.searchParams.get('kind') === 'projects'
      ? [{ kind: 'project', id: '2', label: 'Backend', detail: 'D:/fixture/backend' }]
      : [{ kind: 'chat', id: peerId, label: 'Revisão existente', detail: 'Em execução · Modelo B' }] } });
    if (path.endsWith('/collaboration/references')) {
      references.push(body); config.projectIds = [...new Set([...config.projectIds, ...body.projectIds])];
      data.peers = [{ id: `chat:${peerId}`, sessionId: peerId, label: 'Revisão existente', state: 'running', profile: 'review' }];
      data.chats.push({ id: peerId, title: 'Revisão existente', projectId: 2, provider: 'p2', model: 'm2' });
      data.links.push({ sessions: [id, peerId], enabled: true });
      return route.fulfill({ json: { linked: true } });
    }
    if (path.endsWith('/collaboration/team')) {
      teams.push(body);
      for (const [index, member] of body.members.entries()) {
        const child = `33333333-3333-4333-8333-33333333333${index}`;
        data.peers.push({ id: `chat:${child}`, sessionId: child, label: member.title, state: member.start ? 'running' : 'idle', profile: member.role });
        data.chats.push({ id: child, title: member.title, projectId: member.projectId || 1, provider: member.provider || 'p1', model: member.model || 'm1' });
        data.links.push({ sessions: [id, child], enabled: true });
      }
      return route.fulfill({ json: { created: data.chats.slice(2) } });
    }
    if (path.endsWith('/collaboration/triggers')) {
      data.triggers.push({ ...body, id: 'trigger1', ownerSessionId: id, status: 'waiting', baselineRunId: null, createdAt: Date.now() });
      return route.fulfill({ json: data.triggers[0] });
    }
    if (path.endsWith('/collaboration')) return route.fulfill({ json: data });
    if (path === '/api/coder/providers') return route.fulfill({ json: { providers: [
      { id: 'p1', name: 'Provedor A', models: [{ id: 'm1', name: 'Modelo A' }] },
      { id: 'p2', name: 'Provedor B', models: [{ id: 'm2', name: 'Modelo B' }] },
    ] } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/e2e/fixtures/session-network.html');
  const input = page.locator('textarea').first();
  await input.fill('Avalie com $Back');
  await page.getByRole('option', { name: /Backend/ }).click();
  await input.press('End'); await input.pressSequentially('e @Rev');
  await expect(page.getByRole('listbox', { name: 'Chats', exact: true }).getByRole('option', { name: /Revisão existente/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('session-network-mentions.png') });
  await input.press('Enter'); await input.press('Control+Enter');
  await expect(page.getByTestId('sent')).toContainText('@Revisão existente');
  expect(references[0]).toEqual({ chatIds: [peerId], projectIds: [2] });
  await page.getByRole('button', { name: 'Agêntico', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Agêntico', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Equipe', exact: true }).click();
  for (let index = 1; index <= 5; index++) {
    await page.getByRole('button', { name: 'Adicionar participante' }).click();
    await page.getByLabel(`Nome do participante ${index}`, { exact: true }).fill(['Produto', 'Arquitetura', 'Segurança', 'Desempenho', 'Revisor crítico'][index - 1]!);
    await page.getByLabel(`Função do participante ${index}`, { exact: true }).fill(`Investigar perspectiva ${index} e debater evidências com os colegas.`);
    await page.getByLabel(`Modelo do participante ${index}`, { exact: true }).selectOption(JSON.stringify(index % 2 ? ['p1', 'm1'] : ['p2', 'm2']));
  }
  await page.getByLabel('Objetivo comum da equipe').fill('Decidir se a feature deve ser implementada.');
  await page.getByRole('button', { name: 'Criar sessões preparadas' }).click();
  await expect(page.getByLabel('Nome do participante 1', { exact: true })).toHaveCount(0);
  expect(teams[0].members).toHaveLength(5);
  expect(teams[0].members.every((member: any) => member.start === false)).toBe(true);
  expect(new Set(teams[0].members.map((member: any) => member.model)).size).toBe(2);
  await page.getByRole('tab', { name: 'Gatilhos', exact: true }).click();
  await page.getByLabel('Quando este chat').selectOption(peerId);
  await page.getByLabel('Tarefa ou aviso para o chat de destino').fill('Ler as conclusões e sintetizar a decisão.');
  await page.getByRole('button', { name: 'Criar gatilho', exact: true }).click();
  await expect(page.getByText('Aguardando · Concluir com sucesso', { exact: true })).toBeVisible();
  expect(data.triggers[0]).toMatchObject({ targetSessionId: id, includeFinal: true });
  await page.getByRole('tab', { name: 'Grafo', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Grafo de colaboração' })).toBeVisible();
  await page.getByRole('button', { name: 'Arquitetura', exact: true }).click();
  await expect(page.getByText('p2 · m2', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Abrir chat', exact: true })).toHaveAttribute('href', /projects\/1\?session=/);
  await page.screenshot({ path: test.info().outputPath('session-network-graph.png') });
  expect(failures).toEqual([]);
});
