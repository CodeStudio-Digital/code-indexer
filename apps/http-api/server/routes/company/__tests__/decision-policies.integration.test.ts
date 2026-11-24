import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asCompanySessionId } from '@mcp/session-storage';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { newRole } from '@mcp/company-contracts/designer.js';
import { ClefDecisions } from '../../../clef-decisions.js';
import { clefQualification, evaluateClef } from '../../../clef-evaluation.js';
import { mountDecisionRoutes } from '../design-decisions.js';
import { createDesignTestHost } from './designer-fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('Company and chat decision policies', () => {
  it('keeps policies independent, suppresses pinned roles and profiles, and only promotes the measured surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'decisions-policy-'));
    roots.push(root);
    const host = await createDesignTestHost(root, { reply: '', changes: {} });
    const master = newRole('master', 'chatgpt', 'sol'),
      reviewer = newRole('reviewer', 'chatgpt', 'sol');
    const company = await host.sessions.createCompanySession({
      name: 'Company',
      project_ids: [1],
      config_json: JSON.stringify({ role_assignments: [master, reviewer] }),
    });
    const chat = await host.store.createSession({
      project_id: 1,
      title: 'Chat',
      provider: 'chatgpt',
      model: 'sol',
      reasoning_effort_override: 'max',
    });
    const files = new CompanySessionFiles({
      companySessionId: asCompanySessionId(company.id),
      sessionStore: host.store,
    });
    const card = files.createKanbanCardSync({
      title: 'Review',
      control: { owner: null, projectId: 1, acceptance: [], visualQA: false },
    });
    const values = new Map<string, string>();
    Object.assign(host.config.providerStore, {
      getAppSetting: (k: string) => values.get(k) ?? null,
      setAppSetting: (k: string, v: string) => values.set(k, v),
      listProviderIdentities: () => [{ id: 'cf', kind: 'cloudflare', enabled: true }],
      getProvider: () => ({
        enabled: true,
        kind: 'cloudflare',
        extra: { account_id: 'a'.repeat(32) },
        api_key: 'fixture',
      }),
    });
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body));
      const probabilities = Object.fromEntries(
        Object.keys(query.questions.pick.criteria).map((id, i) => [id, i === 0 ? 1 : 0]),
      );
      return Response.json({
        success: true,
        result: {
          answers: { pick: { type: 'choice', choice: 'r0', confidence: 1, probabilities } },
          usage: { input_tokens: 32 },
        },
      });
    });
    const app = host.router();
    mountDecisionRoutes(app, host.config, new ClefDecisions(send), async () => ({
      recommendations: [{ role: 'reviewer', kind: 'spawn', score: 1 }],
    }));
    const request = async (method: string, path: string, body?: unknown) => {
      const res = await app.request('/api/' + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return res.json() as Promise<any>;
    };
    const ordinary = 'decisions/chat/' + chat.id,
      team = 'decisions/company/' + company.id;
    const ask = (path: string) =>
      request('POST', path + '/suggest', { text: 'Review the contract', cardId: card.id });
    expect((await ask(ordinary)).reason).toBe('off');
    await request('PATCH', 'admin/clef', {
      enabled: true,
      defaultMode: 'off',
      provider: 'cf',
      dailyLimit: 4,
    });
    expect((await request('PATCH', ordinary, { mode: 'suggest' })).effective).toBe('shadow');
    await request('PATCH', ordinary, { mode: 'off' });
    expect((await request('PATCH', team, { mode: 'suggest' })).effective).toBe('suggest');
    expect((await request('PATCH', team, { mode: 'shadow' })).effective).toBe('shadow');
    const shadow = await ask(team);
    expect(shadow).toMatchObject({ candidate: null, options: ['reviewer'] });
    expect((await ask(ordinary)).reason).toBe('off');
    await request('POST', team + '/feedback', { sampleId: shadow.sampleId, choice: 'reviewer' });
    const admin = await request('GET', 'admin/clef');
    expect(admin.estimate).toMatchObject({ usd: (32 * 0.038) / 1_000_000, unmetered: 0 });
    expect(admin.quality.company.labeled).toBe(1);
    expect(admin.quality.chat.labeled).toBe(0);
    files.updateKanbanCardSync(card.id, { control: { ...card.control!, owner: 'reviewer' } });
    expect((await ask(team)).reason).toBe('fixed');
    expect(send).toHaveBeenCalledTimes(1);
    await request('PATCH', team, { mode: 'off' });
    const measured = Array.from({ length: 100 }, (_, i) => ({
      key: String(i),
      shown: true,
      correct: i < 96,
      baselineCorrect: i < 84,
    }));
    values.set('clef.evaluation.v1.chat.cf', JSON.stringify(measured));
    expect((await request('PATCH', ordinary, { mode: 'suggest' })).effective).toBe('suggest');
    expect((await ask(ordinary)).candidate).toBe('explore');
    expect((await ask(team)).reason).toBe('off');
    await host.store.setSessionAgent(chat.id, 'build');
    expect((await ask(ordinary)).reason).toBe('fixed');
    expect(send).toHaveBeenCalledTimes(2);
    expect(await host.store.getSession(chat.id)).toMatchObject({
      provider: 'chatgpt',
      model: 'sol',
      reasoning_effort_override: 'max',
      agent: 'build',
    });
    await request('PATCH', 'admin/clef', {
      enabled: false,
      defaultMode: 'suggest',
      provider: 'cf',
      dailyLimit: 4,
    });
    expect((await ask(ordinary)).reason).toBe('off');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('requires sufficient coverage, accuracy and a gain on the same cases', () => {
    const examples = Array.from({ length: 100 }, (_, i) => ({
      key: String(i),
      shown: i < 60,
      correct: i < 55,
      baselineCorrect: i < 48,
    }));
    expect(evaluateClef(examples).qualified).toBe(true);
    expect(clefQualification('company', [])).toMatchObject({ basis: 'pilot', canSuggest: true });
    expect(clefQualification('chat', [])).toMatchObject({ basis: 'pilot', canSuggest: false });
    expect(
      clefQualification(
        'company',
        examples.map((r) => ({ ...r, correct: false })),
      ),
    ).toMatchObject({ basis: 'installation', canSuggest: false });
    expect(evaluateClef(examples.slice(0, 99)).qualified).toBe(false);
    expect(evaluateClef(examples.map((r, i) => ({ ...r, shown: i < 40 }))).qualified).toBe(false);
    expect(evaluateClef(examples.map((r) => ({ ...r, baselineCorrect: r.correct }))).qualified).toBe(false);
  });
});
