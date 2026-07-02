import { describe, it, expect } from 'vitest';
import { isIrreversibleTool } from '@mcp/code-agent/core/policy.js';

describe('isIrreversibleTool — internal set', () => {
  it('flags every native git mutation', () => {
    expect(isIrreversibleTool('git_add')).toBe(true);
    expect(isIrreversibleTool('git_commit')).toBe(true);
    expect(isIrreversibleTool('git_branch')).toBe(true);
  });

  it('flags worktree lifecycle', () => {
    expect(isIrreversibleTool('enter_worktree')).toBe(true);
    expect(isIrreversibleTool('exit_worktree')).toBe(true);
  });

  it('flags MCP project/snapshot/index mutations', () => {
    expect(isIrreversibleTool('mcp__index_project')).toBe(true);
    expect(isIrreversibleTool('mcp__delete_project')).toBe(true);
    expect(isIrreversibleTool('mcp__add_snapshot')).toBe(true);
    expect(isIrreversibleTool('mcp__update_snapshot')).toBe(true);
    expect(isIrreversibleTool('mcp__delete_snapshot')).toBe(true);
  });

  it('does NOT flag native git read tools', () => {
    expect(isIrreversibleTool('git_status')).toBe(false);
    expect(isIrreversibleTool('git_diff')).toBe(false);
    expect(isIrreversibleTool('git_log')).toBe(false);
  });

  it('does NOT flag MCP read tools', () => {
    expect(isIrreversibleTool('mcp__list_snapshots')).toBe(false);
    expect(isIrreversibleTool('mcp__get_project_pulse')).toBe(false);
    expect(isIrreversibleTool('mcp__read_file')).toBe(false);
    expect(isIrreversibleTool('mcp__search')).toBe(false);
  });
});

describe('isIrreversibleTool — destructive-verb heuristic (external MCPs)', () => {
  it('catches typical external MCP mutations', () => {
    // Cloudflare-style names
    expect(isIrreversibleTool('mcp__r2_bucket_create')).toBe(true);
    expect(isIrreversibleTool('mcp__r2_bucket_delete')).toBe(true);
    expect(isIrreversibleTool('mcp__kv_namespace_update')).toBe(true);
    expect(isIrreversibleTool('mcp__hyperdrive_config_edit')).toBe(false); // 'edit' is not in the verb list — intentional
    expect(isIrreversibleTool('mcp__d1_database_create')).toBe(true);
    expect(isIrreversibleTool('mcp__d1_database_delete')).toBe(true);
    // ext-prefix variant from mcp-server-manager
    expect(isIrreversibleTool('ext_cf__r2_bucket_delete')).toBe(true);
  });

  it('catches verbs at the start of the name', () => {
    expect(isIrreversibleTool('delete_thing')).toBe(true);
    expect(isIrreversibleTool('create_user')).toBe(true);
    expect(isIrreversibleTool('publish_release')).toBe(true);
    expect(isIrreversibleTool('apply_migration')).toBe(true);
    expect(isIrreversibleTool('commit_changes')).toBe(true);
    expect(isIrreversibleTool('push_branch')).toBe(true);
    expect(isIrreversibleTool('replace_config')).toBe(true);
    expect(isIrreversibleTool('drop_table')).toBe(true);
    expect(isIrreversibleTool('destroy_session')).toBe(true);
    expect(isIrreversibleTool('remove_member')).toBe(true);
  });

  it('does NOT flag tools whose name lacks a destructive verb', () => {
    expect(isIrreversibleTool('mcp__list_models')).toBe(false);
    expect(isIrreversibleTool('mcp__find_implementations')).toBe(false);
    expect(isIrreversibleTool('mcp__search_memory')).toBe(false);
    expect(isIrreversibleTool('read_file')).toBe(false);
    expect(isIrreversibleTool('list_directory')).toBe(false);
    expect(isIrreversibleTool('grep_code')).toBe(false);
  });

  it('accepted false-positives: set_* is treated as mutation', () => {
    // Documented trade-off — the user can confirm and proceed.
    expect(isIrreversibleTool('mcp__set_active_account')).toBe(true);
  });
});
