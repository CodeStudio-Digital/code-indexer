import { describe, expect, it } from 'vitest';
import { buildAppStudioTools } from '../index.js';

const V6_TOOLS = [
  'app_get_state',
  'app_get_plan',
  'app_update_plan',
  'app_upsert_work_items',
  'app_request_decision',
  'app_request_plan_approval',
  'app_dispatch_ready_work',
  'app_record_work_evidence',
  'app_get_db_state',
  'app_update_database',
  'app_run_checks',
];

describe('App Studio v6 tool surface', () => {
  it('exposes only the canonical tools to the persistent Company master', () => {
    const names = buildAppStudioTools(42, {
      audience: 'company-master',
      appSessionId: 7,
    }).map((tool) => tool.name);

    expect(names).toEqual(V6_TOOLS);
    expect(names).not.toContain('execute_tasks');
    expect(names).not.toContain('app_get_workflow');
    expect(names).not.toContain('app_update_spec');
  });

  it('refuses a non-persistent App binding', () => {
    expect(() => buildAppStudioTools(42, {
      audience: 'company-master',
      appSessionId: 0,
    })).toThrow(/positive appSessionId/);
  });
});
