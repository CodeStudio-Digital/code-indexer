/**
 * Tests for code_exec failure hints — the P6 authoring-error guards.
 * Telemetry (jul/2026): "SyntaxError: Unexpected identifier 'corporate'"
 * (unquoted path) was the #2 code_exec authoring error (19 cases).
 */
import { describe, expect, it } from 'vitest';
import { buildCodeExecFailureHint } from '@mcp/code-agent/tools/code-exec-hints.js';

const ctx = {
  exposedNames: ['read_file', 'run_command', 'mcp__grep_code'],
  allToolNames: new Set(['read_file', 'run_command', 'mcp__grep_code', 'task_complete']),
};

describe('buildCodeExecFailureHint — unquoted path (P6)', () => {
  it('explains a lexical declaration that shadows the reserved tools proxy', () => {
    const hint = buildCodeExecFailureHint(
      "SyntaxError: Identifier 'tools' has already been declared",
      ctx,
    );
    expect(hint).toContain('reserved code_exec tool proxy');
    expect(hint).toContain('toolResults');
  });

  it('recognizes the unquoted-path SyntaxError and suggests quoting', () => {
    const hint = buildCodeExecFailureHint(
      "code_exec parse/sync error: SyntaxError: Unexpected identifier 'corporate'",
      ctx,
    );
    expect(hint).toContain('UNQUOTED string');
    expect(hint).toContain('corporate');
    expect(hint).toContain('quotes');
  });

  it('still routes ReferenceError cases to the tool-call hint (regression)', () => {
    const hint = buildCodeExecFailureHint('ReferenceError: read_file is not defined', ctx);
    expect(hint).toContain('await read_file(args)');
  });

  it('returns empty for unrelated messages', () => {
    expect(buildCodeExecFailureHint('some other failure', ctx)).toBe('');
  });
});
