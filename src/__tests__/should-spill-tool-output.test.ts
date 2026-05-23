import { describe, it, expect } from 'vitest';
import { shouldSpillToolOutput } from '@mcp/code-agent/core/runner.js';

/**
 * Failure-aware side-file spill (Item C) — extends the original
 * size-only trigger so that any tool error gets its full output
 * persisted to ToolOutputStore, regardless of length. The agent can
 * then recover the buried stack trace via `get_tool_output(id)`
 * instead of rerunning the failing command (a turn + tokens it can't
 * afford on a flaky session).
 */

describe('shouldSpillToolOutput — size + failure triggers', () => {
  const CAP = 1_000;

  it('returns false for a small successful result', () => {
    expect(shouldSpillToolOutput({ content: 'ok', isError: false }, CAP)).toBe(false);
  });

  it('returns false when isError is undefined and content fits in cap', () => {
    expect(shouldSpillToolOutput({ content: 'x'.repeat(500) }, CAP)).toBe(false);
  });

  it('returns true when content exceeds the cap (legacy size trigger)', () => {
    expect(shouldSpillToolOutput({ content: 'x'.repeat(CAP + 1), isError: false }, CAP)).toBe(true);
  });

  it('returns true for any failed result, even when content is tiny', () => {
    expect(shouldSpillToolOutput({ content: 'FAILED tests/foo.py::bar', isError: true }, CAP)).toBe(true);
  });

  it('returns true for an empty failed result (defensive)', () => {
    expect(shouldSpillToolOutput({ content: '', isError: true }, CAP)).toBe(true);
  });

  it('returns true when both triggers fire — size AND failure', () => {
    expect(shouldSpillToolOutput({ content: 'x'.repeat(CAP + 1), isError: true }, CAP)).toBe(true);
  });

  it('treats isError === undefined the same as false', () => {
    expect(shouldSpillToolOutput({ content: 'short' }, CAP)).toBe(false);
  });
});
