/**
 * Timeout/interactive classification (anti-trava parte 2).
 *
 *   - `resolveToolTimeoutMs` must put the orchestration tools (`spawn_agent`,
 *     `execute_tasks`) in the SLOW (30 min) tier instead of the 5-min NORMAL
 *     default that was killing them.
 *   - `resolveToolMetadata` (policy) is the source of truth for which tools
 *     are interactive — including `submit_spec`, which was missing from the
 *     classification entirely.
 */
import { describe, it, expect } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { resolveToolTimeoutMs, SLOW_TIMEOUT_MS, NORMAL_TIMEOUT_MS } from '../tool-timeouts.js';
import { resolveToolMetadata } from '../policy.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';

const t = (partial: Partial<CoderTool>): CoderTool =>
  ({
    name: 'x',
    description: '',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: '' }),
    ...partial,
  }) as CoderTool;

describe('resolveToolTimeoutMs — orchestrators in the SLOW tier', () => {
  it('gives spawn_agent and execute_tasks the SLOW (30 min) timeout', () => {
    expect(resolveToolTimeoutMs(t({ name: 'spawn_agent' }))).toBe(SLOW_TIMEOUT_MS);
    expect(resolveToolTimeoutMs(t({ name: 'execute_tasks' }))).toBe(SLOW_TIMEOUT_MS);
  });

  it('keeps a plain native tool on NORMAL', () => {
    expect(resolveToolTimeoutMs(t({ name: 'read_file' }))).toBe(NORMAL_TIMEOUT_MS);
  });

  it('opts interactive and repeatable tools out of any timeout', () => {
    expect(resolveToolTimeoutMs(t({ name: 'whatever', interactive: true }))).toBe(Infinity);
    expect(resolveToolTimeoutMs(t({ name: 'whatever', repeatable: true }))).toBe(Infinity);
  });
});

describe('resolveToolMetadata — interactive classification (policy)', () => {
  it('classifies submit_spec, submit_plan, submit_tasks and ask_user as interactive', () => {
    expect(resolveToolMetadata(t({ name: 'submit_spec' })).interactive).toBe(true);
    expect(resolveToolMetadata(t({ name: 'submit_plan' })).interactive).toBe(true);
    expect(resolveToolMetadata(t({ name: 'submit_tasks' })).interactive).toBe(true);
    expect(resolveToolMetadata(t({ name: 'ask_user' })).interactive).toBe(true);
  });

  it('classifies the master-directed blocking tools as interactive', () => {
    // ask_master + submit_*_to_master plus the inbox-wait pair: all block for a
    // reply (own 20-min deadline) and must opt out of the 5-min NORMAL timeout.
    for (const name of [
      'ask_master',
      'submit_plan_to_master',
      'submit_tasks_to_master',
      'send_to_master',
      'send_to_agent',
    ]) {
      expect(resolveToolMetadata(t({ name })).interactive, name).toBe(true);
    }
  });

  it('leaves a normal tool non-interactive', () => {
    expect(resolveToolMetadata(t({ name: 'read_file' })).interactive).toBe(false);
  });
});

describe('run_command and code_exec timeout policy', () => {
  it('caps run_command at 10 minutes via an explicit tool timeoutMs', () => {
    const runCommand = shellTools.find((tool) => tool.name === 'run_command')!;
    expect(runCommand.timeoutMs).toBe(10 * 60_000);
    expect(resolveToolTimeoutMs(runCommand)).toBe(10 * 60_000);
  });

  it('keeps code_exec out of the SLOW tier (it self-caps at 30s)', () => {
    expect(resolveToolTimeoutMs(t({ name: 'code_exec' }))).toBe(NORMAL_TIMEOUT_MS);
    expect(resolveToolTimeoutMs(t({ name: 'code_exec' }))).not.toBe(SLOW_TIMEOUT_MS);
  });
});
