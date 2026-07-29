import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { categoryForTable } from '../exporter.js';
import type { BundlePlan, LegacyEntityKind } from '../model.js';

function plan(kind: LegacyEntityKind): BundlePlan {
  return {
    identity: { kind, id: 1 },
    uuid: '018f0f5e-7b2d-7a45-8c11-0123456789ab',
    scope: 'global',
    finalDir: 'D:/bundle',
    stagingDir: 'D:/staging',
  };
}

describe('shared session entity category routing', () => {
  it.each([
    'coder',
    'company',
    'app_studio',
  ] as const)('routes %s pipeline telemetry to metrics/pipeline_stages', (kind) => {
    expect(categoryForTable(plan(kind), 'pipeline_telemetry'))
      .toBe(join('metrics', 'pipeline_stages'));
  });

  it('keeps Company quality and drive records out of workflow-steps', () => {
    const company = plan('company');
    expect(categoryForTable(company, 'quality_classifications'))
      .toBe(join('metrics', 'quality_classifications'));
    expect(categoryForTable(company, 'quality_interventions'))
      .toBe(join('events', 'quality_interventions'));
    expect(categoryForTable(company, 'company_drive_files'))
      .toBe(join('company', 'drive-files'));
  });

  it('routes counterfactual metrics consistently for coder and Company', () => {
    expect(categoryForTable(plan('coder'), 'counterfactual_logs'))
      .toBe(join('metrics', 'counterfactual'));
    expect(categoryForTable(plan('company'), 'counterfactual_logs'))
      .toBe(join('metrics', 'counterfactual'));
  });
});
