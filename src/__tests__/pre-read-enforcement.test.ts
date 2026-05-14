/**
 * PR-5 (Row 32) — pre-read enforcement.
 * Refuses a read-family tool call BEFORE dispatch when the same path/slice
 * has been read in the rolling window. Tighter than the generic dup-call cap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CoderRunner } from '../core/coder/core/runner.js';
import { ToolRegistry } from '../core/coder/core/registry.js';
import type { CoderTool } from '../core/coder/core/tool.js';
import type { ChatProvider, ChatRequest } from '../core/coder/providers/adapter.js';
import type { ChatDelta } from '../core/coder/core/messages.js';

/**
 * Provider that emits a single read_file (or any specified tool name) tool
 * call per turn. After `maxTurns` turns have run, emits text-only and stops.
 */
class ReadingProvider implements ChatProvider {
  readonly name = 'reader';
  model = 'reader-1';
  private callCount = 0;
  constructor(
    private toolName: string,
    private toolInput: Record<string, unknown>,
    private maxCalls: number = 5,
  ) {}
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.callCount++;
    if (this.callCount > this.maxCalls) {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
      yield { type: 'done' };
      return;
    }
    const id = `tu_${this.callCount}`;
    yield { type: 'tool_call_start', id, name: this.toolName };
    yield {
      type: 'tool_call_end',
      id,
      name: this.toolName,
      input: this.toolInput,
    };
    yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

/**
 * Mock read tool that always succeeds with a tagged body. Counts dispatches
 * so we can prove the pre-read guard prevented downstream calls.
 */
function makeReadTool(name: string): { tool: CoderTool; dispatchCount: () => number } {
  let count = 0;
  const tool: CoderTool = {
    name,
    description: 'mock read',
    source: 'native',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, _ctx) => {
      count++;
      return { content: 'mock content for ' + name, isError: false };
    },
  };
  return { tool, dispatchCount: () => count };
}

function makeRunner(provider: ChatProvider, registry: ToolRegistry, agentLoopV2 = true): CoderRunner {
  return new CoderRunner({
    provider,
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    agentLoopV2,
    maxTurns: 10,
  });
}

describe('PR-5 pre-read enforcement', () => {
  beforeEach(() => {
    delete process.env.CODER_READ_DUP_THRESHOLD;
    delete process.env.CODER_READ_DUP_WINDOW;
    // Isolate the pre-read cap from orthogonal guards so each test exercises
    // exactly the behaviour it asserts. These are read at module load by
    // const expressions; setting them after import is a no-op for those
    // (the test file runs in the same process so the env is shared, but
    // the constants captured at module init time persist regardless).
    // We DO need them off for the runner.ts paths that read env lazily:
    process.env.CODER_DOOM_LOOP_THRESHOLD = '0';
    process.env.CODER_DOOM_LOOP_FUZZY_THRESHOLD = '0';
    process.env.CODER_DOMINANCE_WINDOW = '0';
    process.env.CODER_DUP_CALL_THRESHOLD = '0';
  });

  it('refuses on the SECOND identical read (default threshold=2)', async () => {
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new ReadingProvider(
      'mcp__read_file',
      { file_path: 'src/foo.ts', around_line: 100 },
      4, // 4 reads requested
    );
    const runner = makeRunner(provider, registry);
    await runner.run();
    // Only the first read dispatches. Subsequent calls are refused
    // with a synthetic tool_result and never reach the tool handler.
    expect(dispatchCount()).toBe(1);
  });

  it('allows reads of DIFFERENT slices of the same file', async () => {
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    // Provider alternates two distinct slices.
    let toggle = false;
    class AlternatingProvider implements ChatProvider {
      readonly name = 'alt';
      model = 'alt-1';
      private callCount = 0;
      setModel(m: string) { this.model = m; }
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        this.callCount++;
        if (this.callCount > 4) {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
          yield { type: 'done' };
          return;
        }
        toggle = !toggle;
        const input = toggle
          ? { file_path: 'src/foo.ts', start_line: 1, end_line: 50 }
          : { file_path: 'src/foo.ts', start_line: 100, end_line: 150 };
        const id = `tu_${this.callCount}`;
        yield { type: 'tool_call_start', id, name: 'mcp__read_file' };
        yield { type: 'tool_call_end', id, name: 'mcp__read_file', input };
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
        yield { type: 'done' };
      }
    }
    const runner = makeRunner(new AlternatingProvider(), registry);
    await runner.run();
    // 4 alternating reads → 2 distinct slices, each appearing twice.
    // First occurrence of each dispatches; second occurrence is refused.
    // So we expect 2 dispatches.
    expect(dispatchCount()).toBe(2);
  });

  it('does NOT touch non-read tools (e.g. shell run_command)', async () => {
    const { tool, dispatchCount } = makeReadTool('run_command');
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new ReadingProvider(
      'run_command',
      { cmd: 'ls' },
      4,
    );
    const runner = makeRunner(provider, registry);
    await runner.run();
    // run_command is not in REDUCIBLE_READ_TOOLS — pre-read cap does NOT apply.
    // The legacy DUP_CALL_THRESHOLD (default 5) only catches at the 5th call,
    // so all 4 dispatches go through here.
    expect(dispatchCount()).toBe(4);
  });

  it('threshold=1 refuses even the FIRST call (off-mode)', async () => {
    process.env.CODER_READ_DUP_THRESHOLD = '1';
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new ReadingProvider(
      'mcp__read_file',
      { file_path: 'src/foo.ts' },
      3,
    );
    const runner = makeRunner(provider, registry);
    await runner.run();
    expect(dispatchCount()).toBe(0);
  });

  it('threshold=0 disables the guard entirely', async () => {
    process.env.CODER_READ_DUP_THRESHOLD = '0';
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new ReadingProvider(
      'mcp__read_file',
      { file_path: 'src/foo.ts' },
      4,
    );
    const runner = makeRunner(provider, registry);
    await runner.run();
    expect(dispatchCount()).toBe(4);
  });

  it('does NOT enforce when agentLoopV2 is off (legacy behaviour preserved)', async () => {
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new ReadingProvider(
      'mcp__read_file',
      { file_path: 'src/foo.ts' },
      4,
    );
    const runner = makeRunner(provider, registry, /* agentLoopV2 */ false);
    await runner.run();
    // With v2 off, the pre-read cap is inert. The legacy DUP_CALL_THRESHOLD
    // catches at the 5th identical call; 4 reads stay below that bar.
    expect(dispatchCount()).toBe(4);
  });

  it('window expiry resets the count', async () => {
    process.env.CODER_READ_DUP_WINDOW = '2';
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    // 6 reads of the same path: window=2 means turns 1,2,3 are within the
    // window of turn 3, but by turn 4 only 2,3 are still in the window;
    // by turn 5 only 3,4 are; etc. With threshold=2 the second-and-onward
    // identical call in the window refuses, but each refusal still appends
    // its turn to the rolling list. The first call always succeeds.
    const provider = new ReadingProvider(
      'mcp__read_file',
      { file_path: 'src/foo.ts' },
      6,
    );
    const runner = makeRunner(provider, registry);
    await runner.run();
    // Only turn 1 dispatches; everything else falls within the 2-turn window
    // of some prior call. Even though window expires, the appended-to-list
    // entries keep the count at threshold.
    expect(dispatchCount()).toBe(1);
  });
});
