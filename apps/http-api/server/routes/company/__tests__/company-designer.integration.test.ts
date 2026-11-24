import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  newRole,
  protectDesignPins,
  type DesignDraft,
  type DesignTask,
} from '@mcp/company-contracts/designer.js';
import { companyConfigRevision } from '@mcp/company/services/session-identity.js';
import { createDesignTestHost } from './designer-fixture.js';

vi.mock('../../../../sse/companyOrchestrator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../sse/companyOrchestrator.js')>()),
  getCompanyOrchestrator: () => null,
  getOrSpawnCompanyOrchestrator: () => {
    throw Error('Design unexpectedly started an agent');
  },
}));
const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
const task = (id: string, owner: string, projectId: number, dependsOn: string[] = []): DesignTask => ({
  id,
  title: id,
  description: 'Synthetic contract',
  owner,
  projectId,
  dependsOn,
  criteria: ['Verified'],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'company-designer-'));
  cleanup.push(root);
  const host = await createDesignTestHost(root, {
    reply: 'Dois analistas e um revisor.',
    changes: { name: 'Proposta', goal: 'Cruzar contratos' },
  });
  function start() {
    const app = host.router();
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.request('/api/company/' + path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return { status: res.status, data: (await res.json()) as any };
    };
  }
  const api = start();
  const created = await api('POST', 'drafts', { provider: 'chatgpt', model: 'sol' });
  expect(created.status).toBe(201);
  const draft: DesignDraft = created.data;
  const master = newRole('master', 'chatgpt', 'sol');
  const roles = [
    master,
    ...['backend', 'intranet', 'reviewer'].map((name, i) => ({
      ...newRole(name, 'chatgpt', 'sol'),
      readOnly: true,
      projectIds: i === 2 ? [1, 2] : [i + 1],
      skills: ['contract'],
      effort: 'max',
    })),
  ];
  const plan = {
    ...draft.plan,
    name: 'Cross-project',
    goal: 'Validation',
    projectIds: [1, 2],
    roles,
    concurrency: 2,
    tasks: [task('A', 'backend', 1), task('B', 'intranet', 2), task('C', 'reviewer', 1, ['A', 'B'])],
  };
  const saved = await api('PATCH', 'drafts/' + draft.id, {
    expectedRevision: draft.revision,
    changes: plan,
    pins: ['name'],
  });
  expect(saved.status).toBe(200);
  return { ...host, api, start, root, draft: saved.data as DesignDraft, plan };
}
describe('Company designer HTTP and filesystem', () => {
  it('retains pins, detects stale revisions, validates the requested provider, and starts no agent while designing', async () => {
    const { api, draft, disable } = await fixture();
    const proposal = await api('POST', 'drafts/' + draft.id + '/proposals', {
      expectedRevision: draft.revision,
      request: 'Monte a equipe',
      provider: 'chatgpt',
      model: 'sol',
    });
    expect(proposal.status).toBe(200);
    expect(proposal.data.changes).toEqual({ goal: 'Cruzar contratos' });
    const stale = await api('PATCH', 'drafts/' + draft.id, {
      expectedRevision: 1,
      changes: { name: 'Overwrite' },
    });
    expect(stale.status).toBe(409);
    disable();
    expect(
      (
        await api('POST', 'drafts/' + draft.id + '/apply', {
          expectedRevision: draft.revision,
          key: draft.id,
        })
      ).status,
    ).toBe(400);
    expect((await api('GET', 'companies')).data).toEqual([]);
  });
  it.each(['card', 'dependencies'])(
    'recovers the same company and board after failing in %s, then enforces evidence',
    async (phase) => {
      const { api, draft, start } = await fixture();
      // The physical writes belong to the underlying services (public facade binds instance methods).
      const { CompanyKanbanFiles } = await import('@mcp/company/services/company-kanban-files.js');
      const { CompanyKanbanRelations } = await import('@mcp/company/services/company-kanban-relations.js');
      const spy =
        phase === 'card'
          ? vi.spyOn(CompanyKanbanFiles.prototype, 'createKanbanCardSync').mockImplementationOnce(() => {
              throw Error('disk interruption');
            })
          : vi
              .spyOn(CompanyKanbanRelations.prototype, 'addKanbanDependencySync')
              .mockImplementationOnce(() => {
                throw Error('disk interruption');
              });
      const url = 'drafts/' + draft.id + '/apply';
      const body = { expectedRevision: draft.revision, key: draft.id };
      const failed = await api('POST', url, body);
      expect(failed.status).toBe(400);
      expect(failed.data.error).toContain('disk interruption');
      expect((await api('GET', 'companies')).data).toEqual([]);
      const interrupted = (await api('GET', 'drafts/' + draft.id)).data;
      expect((await api('GET', 'sessions/' + interrupted.apply.companyId + '/kanban')).data).toEqual([]);
      spy.mockRestore();
      const recovered = start();
      const [first, second] = await Promise.all([recovered('POST', url, body), recovered('POST', url, body)]);
      expect(first.status, JSON.stringify(first.data)).toBe(200);
      expect(second.data.apply).toEqual(first.data.apply);
      expect((await recovered('GET', 'companies')).data).toHaveLength(1);
      const { companyId, cardIds } = first.data.apply;
      const full = (await recovered('GET', 'sessions/' + companyId)).data;
      expect(full.agentRuns).toEqual([]);
      expect(full.session.status).toBe('idle');
      expect(JSON.parse(full.session.config_json).role_assignments[3]).toMatchObject({
        provider: 'chatgpt',
        model: 'sol',
        reasoningEffort: 'max',
        readOnly: true,
      });
      const board = 'sessions/' + companyId + '/kanban';
      const cards = (await recovered('GET', board)).data;
      const rows = Array.isArray(cards) ? cards : cards.cards;
      expect(rows).toHaveLength(3);
      expect(rows.find((c: any) => c.id === cardIds.C).blocked_by.sort()).toEqual(
        [cardIds.A, cardIds.B].sort(),
      );
      expect((await recovered('POST', board + '/' + cardIds.C + '/move', { column: 'review' })).status).toBe(
        409,
      );
      const a = rows.find((c: any) => c.id === cardIds.A);
      expect(
        (await recovered('POST', board + '/' + a.id + '/move', { column: 'done' })).status,
      ).toBeGreaterThanOrEqual(400);
      const evidence = await recovered('POST', board + '/' + a.id + '/control', {
        expectedUpdatedAt: a.updated_at,
        control: { ...a.control, acceptance: [{ criterion: 'Verified', evidence: 'contract.test:14' }] },
      });
      expect(evidence.status, JSON.stringify(evidence.data)).toBe(200);
      expect((await recovered('POST', board + '/' + a.id + '/move', { column: 'review' })).status).toBe(200);
      expect((await recovered('POST', board + '/' + a.id + '/move', { column: 'done' })).status).toBe(200);
    },
  );
  it('keeps a pinned model and manual deletions while adding a new team member', async () => {
    const { draft } = await fixture();
    const current = draft.plan.roles.find((r) => r.role === 'reviewer')!;
    const analyst = { ...current, role: 'auditor' };
    const protectedPlan = protectDesignPins(
      { ...draft, pins: ['roles:reviewer:provider', 'roles:reviewer:model', 'roles:removed'] },
      {
        roles: [
          { ...current, provider: 'bedrock', model: 'other', responsibility: 'New evidence' },
          analyst,
          { ...analyst, role: 'removed' },
        ],
      },
    );
    expect(protectedPlan.roles).toMatchObject([
      { role: 'reviewer', provider: 'chatgpt', model: 'sol', responsibility: 'New evidence' },
      { role: 'auditor' },
    ]);
  });
  it('keeps the old configuration in an active child and exposes the new revision to new and idle children', async () => {
    const { api, draft, sessions } = await fixture();
    const initial = await api('POST', 'drafts/' + draft.id + '/apply', {
      expectedRevision: draft.revision,
      key: draft.id,
    });
    expect(initial.status).toBe(200);
    const id = initial.data.apply.companyId;
    const child = (await api('POST', 'companies/' + id + '/sessions', { name: 'First' })).data;
    const old = companyConfigRevision(child.config_json);
    await sessions.updateCompanySessionStatus(child.id, 'running');
    const reconfig = (await api('POST', 'drafts', { sourceId: id })).data;
    const changed = await api('PATCH', 'drafts/' + reconfig.id, {
      expectedRevision: reconfig.revision,
      changes: { rules: 'new rules' },
    });
    const result = await api('POST', 'drafts/' + reconfig.id + '/apply', {
      expectedRevision: changed.data.revision,
      key: reconfig.id,
    });
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    const next = (await api('POST', 'companies/' + id + '/sessions', { name: 'Next' })).data;
    expect(JSON.parse(next.config_json).operational_rules).toBe('new rules');
    expect((await sessions.getCompanySession(child.id))?.config_json).toBe(child.config_json);
    const adopt = 'companies/' + id + '/sessions/' + child.id + '/config/adopt';
    const body = {
      expectedCompanyRevision: companyConfigRevision(next.config_json),
      expectedSessionRevision: old,
    };
    expect((await api('POST', adopt, body)).status).toBe(409);
    await sessions.updateCompanySessionStatus(child.id, 'idle');
    expect((await api('POST', adopt, body)).status).toBe(200);
    expect(JSON.parse((await sessions.getCompanySession(child.id))!.config_json).operational_rules).toBe(
      'new rules',
    );
  });
  it('rejects cycles and a role bound to a different project before creating any bundle', async () => {
    const { api, draft, plan } = await fixture();
    for (const tasks of [[task('A', 'backend', 2)], [task('A', 'backend', 1, ['A'])]]) {
      const latest = (await api('GET', 'drafts/' + draft.id)).data;
      const changed = (
        await api('PATCH', 'drafts/' + draft.id, { expectedRevision: latest.revision, changes: { tasks } })
      ).data;
      const out = await api('POST', 'drafts/' + draft.id + '/apply', {
        expectedRevision: changed.revision,
        key: randomUUID(),
      });
      expect(out.status).toBe(400);
      expect((await api('GET', 'companies')).data).toEqual([]);
    }
  });
});
