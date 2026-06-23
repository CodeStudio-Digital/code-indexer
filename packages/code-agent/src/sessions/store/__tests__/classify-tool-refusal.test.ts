/**
 * classifyToolRefusal — separates synthesized loop-guard refusals from real
 * tool failures so per-tool error rates aren't inflated (mig 124).
 */
import { describe, it, expect } from 'vitest';
import { classifyToolRefusal } from '../messages.js';

describe('classifyToolRefusal', () => {
  it('tags the tuple-hash dedup HARD refuse', () => {
    expect(
      classifyToolRefusal('[loop-refused: identical call to `run_command` (call #3, first at turn 31)]', true),
    ).toBe('dedup');
  });

  it('tags the failure-streak HARD refuse', () => {
    expect(
      classifyToolRefusal('[failure-streak REFUSED: tool `run_command` has failed 5 times consecutively]', true),
    ).toBe('failure-streak');
  });

  it('tags PermissionGate user denials', () => {
    expect(
      classifyToolRefusal('[user-denied: o usuário negou permissão para `write_file`. Motivo: nome errado.]', true),
    ).toBe('user_denied');
  });

  it('tags harness timeouts and aborts', () => {
    expect(
      classifyToolRefusal('[tool-timeout: `web_fetch` exceeded 300000ms. Tune MCP_TOOL_NORMAL_TIMEOUT_MS …]', true),
    ).toBe('timeout');
    expect(
      classifyToolRefusal('[tool-aborted: `run_command` cancelled by user/session.]', true),
    ).toBe('abort');
  });

  it('leaves real tool errors untagged', () => {
    expect(classifyToolRefusal("'head' is not recognized as an internal command", true)).toBeNull();
  });

  it('leaves guard REMINDERS (prepended to a real result) untagged', () => {
    // A reminder is glued onto the real (failed) tool result — the is_error
    // reflects the real call, so it must stay a real error, not a refusal.
    expect(classifyToolRefusal('[failure-streak: `x` has now failed 3 times in a row]\n\nreal error', true)).toBeNull();
    expect(classifyToolRefusal('<system-reminder>[dedup: 2nd identical call to `x`]', true)).toBeNull();
  });

  it('returns null when the row is not an error', () => {
    expect(classifyToolRefusal('[loop-refused: ...]', false)).toBeNull();
    expect(classifyToolRefusal('', true)).toBeNull();
  });
});
