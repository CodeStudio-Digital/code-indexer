import { describe, expect, it } from 'vitest';
import {
  APP_SPECIALIST_AGENT_IDS,
  APP_SPECIALIST_PRESERVE_OUTPUT_TOOLS,
  APP_SPECIALIST_TOOL_ALLOWLISTS,
  isAppSpecialistAgentId,
} from '../app-specialists.js';
import { APP_STUDIO_TOOLS } from '../../tools/tiers.js';
import { NEVER_TRIM } from '../../tools/tool-priority.js';

describe('App Studio specialist tool contracts', () => {
  it('recognizes every specialist and rejects generic agents', () => {
    for (const id of APP_SPECIALIST_AGENT_IDS) expect(isAppSpecialistAgentId(id)).toBe(true);
    expect(isAppSpecialistAgentId('builder')).toBe(false);
    expect(isAppSpecialistAgentId('explore')).toBe(false);
  });

  it('gives every specialist authoritative context with no generic mutation surface', () => {
    for (const id of APP_SPECIALIST_AGENT_IDS) {
      const tools = APP_SPECIALIST_TOOL_ALLOWLISTS[id];
      expect(tools.has('app_get_context'), id).toBe(true);
      expect(tools.has('write_file'), id).toBe(false);
      expect(tools.has('edit_file'), id).toBe(false);
      expect(tools.has('run_command'), id).toBe(false);
      for (const tool of tools) expect(APP_SPECIALIST_PRESERVE_OUTPUT_TOOLS.has(tool), `${id}:${tool}`).toBe(true);
    }
  });

  it('gives the database specialist a persistent, verifiable migration path', () => {
    const tools = APP_SPECIALIST_TOOL_ALLOWLISTS.app_db;
    expect(tools.has('app_save_db_migration')).toBe(true);
    expect(tools.has('app_provision_db')).toBe(true);
    expect(tools.has('db_schema')).toBe(true);
    expect(tools.has('db_query')).toBe(true);
  });

  it('lets the architecture specialist propose versioned requirement changes', () => {
    const tools = APP_SPECIALIST_TOOL_ALLOWLISTS.app_architect;
    expect(tools.has('app_spec_audit')).toBe(true);
    expect(tools.has('app_save_spec')).toBe(true);
    expect(tools.has('app_propose_spec_revision')).toBe(true);
    expect(tools.has('app_save_db_migration')).toBe(false);
    expect(tools.has('write_file')).toBe(false);
  });

  it('classifies every reduced App Studio tool explicitly in the tier catalog', () => {
    for (const id of APP_SPECIALIST_AGENT_IDS) {
      for (const tool of APP_SPECIALIST_TOOL_ALLOWLISTS[id]) {
        if (tool === 'ask_user' || tool.startsWith('db_')) continue;
        expect(APP_STUDIO_TOOLS.has(tool), `${id}:${tool}`).toBe(true);
      }
    }
  });

  it('protects the planner/executor control plane from compact-model trimming', () => {
    expect(NEVER_TRIM.has('app_get_context')).toBe(true);
    expect(NEVER_TRIM.has('app_get_spec')).toBe(true);
    expect(NEVER_TRIM.has('app_submit_stage')).toBe(true);
  });
});
