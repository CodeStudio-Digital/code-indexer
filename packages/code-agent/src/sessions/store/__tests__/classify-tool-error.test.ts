/**
 * classifyToolError — coarse error_class for REAL tool failures (mig 186).
 * Harness refusals (refusal_kind territory) and successes must return null.
 */
import { describe, expect, it } from 'vitest';
import { classifyToolError } from '../tool-error-class.js';

describe('classifyToolError', () => {
  it('returns null on success or empty text', () => {
    expect(classifyToolError('done', false)).toBeNull();
    expect(classifyToolError('', true)).toBeNull();
  });

  it('returns null on harness refusals — refusal_kind owns those rows', () => {
    expect(classifyToolError('[loop-refused: identical call to `run_command` (call #3)]', true)).toBeNull();
    expect(classifyToolError('[user-denied: o usuário negou permissão para `write_file`.]', true)).toBeNull();
    expect(classifyToolError('[tool-timeout: `web_fetch` exceeded 300000ms.]', true)).toBeNull();
  });

  it('classifies unknown tool (registry miss)', () => {
    expect(classifyToolError('Unknown tool: grep_code. Did you mean `mcp__grep_code`?', true)).toBe('unknown_tool');
  });

  it('classifies registry-wrapped handler throws by inner message', () => {
    expect(classifyToolError("Tool 'read_file' failed: ENOENT: no such file or directory", true)).toBe('not_found');
    expect(classifyToolError("Tool 'write_file' failed: EACCES: permission denied", true)).toBe('permission');
    expect(classifyToolError("Tool 'web_fetch' failed: fetch failed", true)).toBe('network');
    expect(classifyToolError("Tool 'code_exec' failed: unexpected token in script", true)).toBe('handler_exception');
  });

  it('classifies tool-authored not-found errors', () => {
    expect(classifyToolError('File "src/x.ts" not found in index. Use list_directory or search.', true)).toBe('not_found');
    expect(classifyToolError('Symbol with id 42 not found. Use search or get_file_skeleton.', true)).toBe('not_found');
  });

  it('classifies shell failures', () => {
    expect(classifyToolError('pnpm test exited with code 1\nFAIL src/foo.test.ts', true)).toBe('command_failed');
  });

  it('classifies sandbox/policy containment', () => {
    expect(classifyToolError('Path "C:/Windows" is outside the project root.', true)).toBe('policy');
  });

  it('classifies invalid arguments', () => {
    expect(classifyToolError('Invalid arguments: `updates` must be an array', true)).toBe('invalid_args');
    expect(classifyToolError('missing required parameter: query', true)).toBe('invalid_args');
  });

  it('falls back to other for unrecognized errors', () => {
    expect(classifyToolError('something exploded in a novel way', true)).toBe('other');
  });
});
