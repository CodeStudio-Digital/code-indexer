/**
 * Incident fan-out tests — pure fakes for notifier/board/kanban/inbox.
 * Covers the card dedupe (open `[incident:<serviceId>]` card gets a
 * comment, not a duplicate) and the devops-skill inbox routing.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildIncidentMessage,
  emitIncident,
  findRoleWithSkill,
  incidentCardTitle,
  type IncidentDeps,
  type ServiceIncident,
} from '../incidents.js';

const incident: ServiceIncident = {
  sessionId: 12,
  serviceId: 'api',
  detail: 'container not running (exit=137)',
  restartAttempts: 3,
  atMs: 1_000,
};

function makeDeps(over: Partial<IncidentDeps> = {}) {
  const calls = {
    notify: vi.fn(),
    post: vi.fn(),
    publish: vi.fn(),
    createCard: vi.fn(() => ({ id: 99 })),
    addComment: vi.fn(),
    send: vi.fn(async () => ({})),
  };
  const deps: IncidentDeps = {
    notifyMaster: calls.notify,
    board: { post: calls.post },
    publisher: { publish: calls.publish },
    kanban: {
      listCardsFull: () => [],
      createCard: calls.createCard,
      addComment: calls.addComment,
    },
    inbox: { send: calls.send },
    getSessionConfigJson: () => null,
    ...over,
  };
  return { deps, calls };
}

describe('buildIncidentMessage', () => {
  it('mentions the service, the attempt count and the evidence', () => {
    const msg = buildIncidentMessage(incident);
    expect(msg).toContain('**api**');
    expect(msg).toContain('3 restart attempts');
    expect(msg).toContain('exit=137');
  });

  it('B8 — local ids get host-process wording, not container remediation', () => {
    const msg = buildIncidentMessage({
      sessionId: 12,
      serviceId: 'local:12',
      detail: 'process 4242 not running',
      restartAttempts: 0,
      atMs: 1_000,
    });
    expect(msg).toContain('**local:12**');
    expect(msg).toContain('host process');
    expect(msg).toContain('process 4242 not running');
    expect(msg).not.toContain('rebuild the container');
    expect(msg).not.toContain('restart attempt');
  });
});

describe('findRoleWithSkill', () => {
  it('finds the legacy string[] form', () => {
    const cfg = JSON.stringify({
      role_assignments: [
        { role: 'frontend', skills: ['react'] },
        { role: 'ops', skills: ['devops', 'qa-playwright'] },
      ],
    });
    expect(findRoleWithSkill(cfg, 'devops')).toBe('ops');
  });

  it('finds the v2 RoleSkillsConfig form (primary/chain)', () => {
    const cfg = JSON.stringify({
      role_assignments: [{ role: 'sre', skills: { primary: 'devops', chain: ['qa'] } }],
    });
    expect(findRoleWithSkill(cfg, 'devops')).toBe('sre');
  });

  it('tolerates malformed input', () => {
    expect(findRoleWithSkill(null, 'devops')).toBeNull();
    expect(findRoleWithSkill('not json', 'devops')).toBeNull();
    expect(findRoleWithSkill('{}', 'devops')).toBeNull();
    expect(findRoleWithSkill(JSON.stringify({ role_assignments: [{ skills: 42 }] }), 'devops')).toBeNull();
  });
});

describe('emitIncident', () => {
  it('notifies master, posts a blocker, publishes the metaBus event', async () => {
    const { deps, calls } = makeDeps();
    await emitIncident(deps, incident);
    expect(calls.notify).toHaveBeenCalledWith(expect.stringContaining('[SYSTEM]'));
    // B8 — the master's prompt keys its reaction protocol on this marker.
    expect(calls.notify).toHaveBeenCalledWith(expect.stringContaining('[SERVICE INCIDENT]'));
    expect(calls.post).toHaveBeenCalledWith('system', null, 'blocker', expect.stringContaining('**api**'));
    expect(calls.publish).toHaveBeenCalledWith(
      'sandbox.service.incident',
      expect.objectContaining({ serviceId: 'api', restartAttempts: 3 }),
    );
  });

  it('creates a kanban card when no open incident card exists', async () => {
    const { deps, calls } = makeDeps();
    await emitIncident(deps, incident);
    expect(calls.createCard).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining(incidentCardTitle('api')),
        column: 'todo',
        tag: 'bug',
        created_by: 'supervisor',
      }),
    );
    expect(calls.addComment).not.toHaveBeenCalled();
  });

  it('dedupes: an open marked card gets a comment instead of a duplicate', async () => {
    const { deps, calls } = makeDeps();
    deps.kanban!.listCardsFull = () => [
      { id: 7, column: 'todo', title: `${incidentCardTitle('api')} service down — auto-restart exhausted` },
    ];
    await emitIncident(deps, incident);
    expect(calls.createCard).not.toHaveBeenCalled();
    expect(calls.addComment).toHaveBeenCalledWith(7, 'supervisor', null, expect.stringContaining('Incident re-fired'));
  });

  it('a done card does not block a fresh incident card', async () => {
    const { deps, calls } = makeDeps();
    deps.kanban!.listCardsFull = () => [
      { id: 7, column: 'done', title: `${incidentCardTitle('api')} service down` },
    ];
    await emitIncident(deps, incident);
    expect(calls.createCard).toHaveBeenCalled();
  });

  it('dedupe is per-service: another service\'s card does not match', async () => {
    const { deps, calls } = makeDeps();
    deps.kanban!.listCardsFull = () => [
      { id: 7, column: 'todo', title: `${incidentCardTitle('web')} service down` },
    ];
    await emitIncident(deps, incident);
    expect(calls.createCard).toHaveBeenCalled();
  });

  it('routes to the devops-skilled role via the inbox when one exists', async () => {
    const { deps, calls } = makeDeps({
      getSessionConfigJson: () =>
        JSON.stringify({ role_assignments: [{ role: 'sre', skills: ['devops'] }] }),
    });
    await emitIncident(deps, incident);
    expect(calls.send).toHaveBeenCalledWith(
      expect.objectContaining({
        toRole: 'sre',
        kind: 'notify',
        wait: false,
        priority: 'urgent',
        fromRole: 'supervisor',
      }),
    );
  });

  it('skips inbox routing when no role carries the devops skill', async () => {
    const { deps, calls } = makeDeps({
      getSessionConfigJson: () =>
        JSON.stringify({ role_assignments: [{ role: 'frontend', skills: ['react'] }] }),
    });
    await emitIncident(deps, incident);
    expect(calls.send).not.toHaveBeenCalled();
  });

  it('one failing channel never blocks the others', async () => {
    const { deps, calls } = makeDeps();
    deps.board.post = () => { throw new Error('board offline'); };
    deps.kanban!.listCardsFull = () => { throw new Error('kanban offline'); };
    await expect(emitIncident(deps, incident)).resolves.toBeUndefined();
    expect(calls.notify).toHaveBeenCalled();
    expect(calls.publish).toHaveBeenCalled();
  });
});
