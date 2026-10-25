import { describe, expect, it } from 'vitest';
import {
  constrainAutonomyForCapabilities,
  resolveCompanySessionCapabilities,
  resolveCompanyServiceWiringPlan,
} from '../session-capabilities.js';
import {
  buildMasterCompanyBlock,
  buildSubordinateCompanyBlock,
} from '../../system-prompts.js';

const APP_STUDIO_SESSION_ID = '00000000-0000-4000-8000-000000000042';

describe('CompanySessionCapabilities', () => {
  it('keeps generic Company on Kanban without App tools', () => {
    const capabilities = resolveCompanySessionCapabilities('company');
    expect(capabilities).toMatchObject({
      workSource: 'company_kanban',
      allowAppTools: false,
      allowCompanyKanban: true,
      allowCompanyScheduler: true,
      allowAppScheduler: false,
      allowFreeSubordinateSpawn: true,
    });
    expect(resolveCompanyServiceWiringPlan(capabilities)).toEqual({
      initializeCompanyKanban: true,
      initializeCompanyScheduler: true,
      allowIncidentKanbanCards: true,
    });
  });

  it('keeps archived App teams inert after retirement', () => {
    const capabilities = resolveCompanySessionCapabilities(
      'app_studio',
      APP_STUDIO_SESSION_ID,
    );
    expect(capabilities).toMatchObject({
      appStudioSessionId: APP_STUDIO_SESSION_ID,
      promptProfile: 'app_studio',
      toolProfile: 'app_studio',
      autonomyPolicy: 'controlled_app_work',
      workSource: 'app_workflow',
      allowAppTools: false,
      allowCompanyKanban: false,
      allowCompanyScheduler: false,
      allowAppScheduler: false,
      allowFreeSubordinateSpawn: false,
    });
    expect(resolveCompanyServiceWiringPlan(capabilities)).toEqual({
      initializeCompanyKanban: false,
      initializeCompanyScheduler: false,
      allowIncidentKanbanCards: false,
    });
  });

  it('fails closed when an app_studio Company row has no owning App link', () => {
    expect(resolveCompanySessionCapabilities('app_studio', null)).toMatchObject({
      allowAppTools: false,
      allowAppScheduler: false,
      allowCompanyScheduler: false,
      allowCompanyKanban: false,
    });
  });

  it('disables universal approval and generic orphan recovery for App teams', () => {
    const capabilities = resolveCompanySessionCapabilities(
      'app_studio',
      APP_STUDIO_SESSION_ID,
    );
    expect(constrainAutonomyForCapabilities(capabilities, {
      scheduler: true,
      orphanReset: true,
      autoApproveRoles: '*',
      supervisorMaster: true,
      maxSubordinates: 8,
      wipLimits: { in_progress: 2 },
      freeze: false,
    })).toMatchObject({
      scheduler: true,
      orphanReset: false,
      autoApproveRoles: null,
      supervisorMaster: true,
      maxSubordinates: 8,
      wipLimits: {},
      freeze: false,
    });
  });
});

describe('App Studio prompt capability', () => {
  const projects = [{ id: 7, name: 'My App', rootPath: 'D:/app' }];

  it('does not inject generic Kanban delegation into the App Master', () => {
    const prompt = buildMasterCompanyBlock({
      runtimeKind: 'app_studio',
      projects,
      roster: [{
        role: 'backend', provider: 'openai-chatgpt', model: 'gpt-5.6-sol',
        tier: 'full', projectIds: [7],
      }],
    });
    expect(prompt).toContain('App Studio is retired');
    expect(prompt).not.toContain('app_dispatch_ready_work');
    expect(prompt).not.toContain('kanban_card_id');
    expect(prompt).not.toContain('create a card BEFORE');
  });

  it('requires App evidence without injecting Company Kanban self-service', () => {
    const prompt = buildSubordinateCompanyBlock({
      runtimeKind: 'app_studio',
      role: 'backend',
      projects,
    });
    expect(prompt).toContain('App Studio is retired');
    expect(prompt).not.toContain('app_record_work_evidence');
    expect(prompt).not.toContain('kanban_move_to_review');
    expect(prompt).not.toContain('kanban_read_my_card');
  });
});
