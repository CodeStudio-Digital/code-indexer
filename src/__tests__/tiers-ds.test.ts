import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_TOOLS, getToolTier } from '@mcp/code-agent/tools/tiers.js';

describe('tier registration — design-system tools', () => {
  const DS_TOOLS = [
    'ds_get_session_info',
    'ds_record_component',
    'ds_validate_manifest',
    'ds_validate_stories',
    'ds_audit_package',
    'ds_set_version_status',
    'ds_publish_version',
  ] as const;

  it.each(DS_TOOLS)('explicitly lists "%s" in BOOTSTRAP_TOOLS', (tool) => {
    // Explicit registration matters: previously these tools relied on
    // `getToolTier`'s fallback to 'bootstrap' for any unknown name. That
    // worked but was implicit / ungreppable. Future refactors that change
    // the fallback to e.g. 'unknown' or strict mode would silently break
    // DS sessions. Locking the explicit set membership here.
    expect(BOOTSTRAP_TOOLS.has(tool)).toBe(true);
  });

  it.each(DS_TOOLS)('classifies "%s" as bootstrap tier', (tool) => {
    expect(getToolTier(tool)).toBe('bootstrap');
  });

  it('does not regress non-DS bootstrap tools (sanity)', () => {
    expect(BOOTSTRAP_TOOLS.has('ask_master')).toBe(true);
    expect(BOOTSTRAP_TOOLS.has('submit_plan_to_master')).toBe(true);
    expect(BOOTSTRAP_TOOLS.has('kanban_my_comment')).toBe(true);
  });
});

describe('tier registration — company board tools', () => {
  const BOARD_TOOLS = [
    'post_to_board',
    'read_board',
    'set_agent_status',
    'kanban_read_my_card',
  ] as const;

  it.each(BOARD_TOOLS)('explicitly lists "%s" in BOOTSTRAP_TOOLS', (tool) => {
    expect(BOOTSTRAP_TOOLS.has(tool)).toBe(true);
  });

  it.each(BOARD_TOOLS)('classifies "%s" as bootstrap tier', (tool) => {
    expect(getToolTier(tool)).toBe('bootstrap');
  });
});
