import { describe, expect, it } from 'vitest';
import { diffLegacyBoundary } from '../../scripts/rust-agent-legacy-boundary-diff.js';
const group = 'apps/consumer.ts::import::@mcp/code-agent/core/tool.js::';
describe('legacy dependency ratchet', () => {
  it('allows removing a result contract while keeping an existing tool symbol', () => {
    expect(diffLegacyBoundary([group + 'CoderTool'], [group + 'CoderTool,ToolResult,err'])).toEqual({
      additions: [], removals: [group + 'ToolResult,err'],
    });
  });
  it('still rejects a new symbol in an existing file and module', () => {
    expect(diffLegacyBoundary([group + 'CoderTool,ToolContext'], [group + 'CoderTool,ToolResult'])).toEqual({
      additions: [group + 'ToolContext'], removals: [group + 'ToolResult'],
    });
  });
  it('is insensitive to splitting, merging and reordering imports of the same symbols', () => {
    expect(diffLegacyBoundary([group + 'err,CoderTool'], [group + 'CoderTool', group + 'err'])).toEqual({ additions: [], removals: [] });
  });
  it('does not authorize another file, module, import kind or namespace by similarity', () => {
    const foreign = [group.replace('consumer.ts', 'new.ts') + 'CoderTool',
      group.replace('::import::', '::dynamic::') + 'CoderTool',
      group.replace('core/tool.js', 'core/runner.js') + 'CoderTool', group + '*'];
    expect(diffLegacyBoundary(foreign, [group + 'CoderTool']).additions).toHaveLength(4);
  });
  it('tracks symbol-free package and asset references', () => {
    const reference = 'package.json::literal::@mcp/code-agent::';
    expect(diffLegacyBoundary([reference], [])).toEqual({ additions: [reference], removals: [] });
    expect(diffLegacyBoundary([], [reference])).toEqual({ additions: [], removals: [reference] });
    expect(diffLegacyBoundary([reference], [reference])).toEqual({ additions: [], removals: [] });
  });
  it('rejects malformed baselines instead of weakening enforcement', () => {
    expect(() => diffLegacyBoundary([], ['broken'])).toThrow('Invalid legacy');
  });
});
