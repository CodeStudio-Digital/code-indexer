/**
 * PR-5 (Row 32) — pre-read enforcement.
 * Refuses a read-family tool call BEFORE dispatch when the same path/slice
 * has been read in the rolling window. Tighter than the generic dup-call cap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta, ToolResultBlock } from '@mcp/code-agent/core/messages.js';

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

/**
 * Smarter pre-read enforcement (this PR). The legacy refusal was a hard
 * "no" with a generic message; the new guard checks four cases in order:
 *   1. mutation since last read → ALLOW (post-process to diff)
 *   2. all prior results elided → ALLOW (content left the context)
 *   3. CODER_READ_AUTO_DOWNGRADE=1 → return skeleton-style pointer
 *   4. default → rich refusal with turn pointer + mtime + preview
 */
describe('PR-5 smarter pre-read enforcement', () => {
  beforeEach(() => {
    delete process.env.CODER_READ_DUP_THRESHOLD;
    delete process.env.CODER_READ_DUP_WINDOW;
    delete process.env.CODER_READ_AUTO_DOWNGRADE;
    process.env.CODER_DOOM_LOOP_THRESHOLD = '0';
    process.env.CODER_DOOM_LOOP_FUZZY_THRESHOLD = '0';
    process.env.CODER_DOMINANCE_WINDOW = '0';
    process.env.CODER_DUP_CALL_THRESHOLD = '0';
  });

  function getMessages(runner: CoderRunner): AgentMessage[] {
    return (runner as unknown as { messages: AgentMessage[] }).messages;
  }
  function findToolResult(runner: CoderRunner, useId: string): ToolResultBlock | undefined {
    for (const m of getMessages(runner)) {
      if (m.role !== 'tool') continue;
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.tool_use_id === useId) return b as ToolResultBlock;
      }
    }
    return undefined;
  }

  it('allows re-read when the prior tool_result has been elided from context', async () => {
    let runnerRef: CoderRunner | null = null;
    let callCount = 0;
    const provider: ChatProvider = {
      name: 'p', model: 'm-1',
      setModel(m: string) { this.model = m; },
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        callCount++;
        // Before the second tool-emitting turn fires, elide the FIRST
        // tool_result the same way postCompactCleanup would.
        if (callCount === 2 && runnerRef) {
          for (const m of getMessages(runnerRef)) {
            if (m.role !== 'tool') continue;
            m.content = m.content.map((b) =>
              b.type === 'tool_result'
                ? { ...b, content: '[duplicate-read elided] Superseded — original dropped.' }
                : b,
            );
          }
        }
        if (callCount > 3) {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
          yield { type: 'done' };
          return;
        }
        const id = `tu_${callCount}`;
        yield { type: 'tool_call_start', id, name: 'mcp__read_file' };
        yield {
          type: 'tool_call_end',
          id,
          name: 'mcp__read_file',
          input: { file_path: 'src/foo.ts', start_line: 1, end_line: 50 },
        };
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
        yield { type: 'done' };
      },
    };
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    runnerRef = makeRunner(provider, registry);
    await runnerRef.run();
    // Both reads dispatch: the second is allowed because the first was elided.
    expect(dispatchCount()).toBeGreaterThanOrEqual(2);
  });

  it('rich refusal payload includes a turn pointer and the "What to do next" block', async () => {
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new ReadingProvider(
      'mcp__read_file',
      { file_path: 'src/foo.ts', start_line: 1, end_line: 50 },
      4,
    );
    const runner = makeRunner(provider, registry);
    await runner.run();
    expect(dispatchCount()).toBe(1);
    const msgs = getMessages(runner);
    const refusal = msgs
      .flatMap((m) => m.content)
      .find(
        (b): b is ToolResultBlock =>
          b.type === 'tool_result' &&
          typeof b.content === 'string' &&
          b.content.includes('Previous reads:'),
      );
    expect(refusal).toBeDefined();
    expect(refusal!.content).toMatch(/turn 1/);
    expect(refusal!.content).toMatch(/What to do next:/);
    // Rich refusal must still flag is_error so existing consumers continue
    // to treat the synthetic result the same way.
    expect(refusal!.is_error).toBe(true);
  });

  it('auto-downgrade returns a skeleton-style pointer when CODER_READ_AUTO_DOWNGRADE=1', async () => {
    process.env.CODER_READ_AUTO_DOWNGRADE = '1';
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    const provider = new ReadingProvider(
      'mcp__read_file',
      { file_path: 'src/foo.ts', start_line: 1, end_line: 50 },
      3,
    );
    const runner = makeRunner(provider, registry);
    await runner.run();
    expect(dispatchCount()).toBe(1);
    const downgrade = getMessages(runner)
      .flatMap((m) => m.content)
      .find(
        (b): b is ToolResultBlock =>
          b.type === 'tool_result' &&
          typeof b.content === 'string' &&
          b.content.startsWith('[auto-downgraded'),
      );
    expect(downgrade).toBeDefined();
    expect(downgrade!.is_error).not.toBe(true);
  });

  it('allows re-read after edit_file and replaces the content with a unified diff', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      name: 'p', model: 'm-1',
      setModel(m: string) { this.model = m; },
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call_start', id: 'r1', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r1',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts', start_line: 1, end_line: 5 },
          };
        } else if (callCount === 2) {
          yield { type: 'tool_call_start', id: 'e1', name: 'edit_file' };
          yield {
            type: 'tool_call_end',
            id: 'e1',
            name: 'edit_file',
            input: { path: 'src/foo.ts', old_string: 'line 2', new_string: 'LINE 2 CHANGED' },
          };
        } else if (callCount === 3) {
          yield { type: 'tool_call_start', id: 'r2', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r2',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts', start_line: 1, end_line: 5 },
          };
        } else {
          yield { type: 'text_delta', text: 'done' };
        }
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
        yield { type: 'done' };
      },
    };
    let readCallNum = 0;
    const readContents = [
      'line 1\nline 2\nline 3\nline 4\nline 5',
      'line 1\nLINE 2 CHANGED\nline 3\nline 4\nline 5',
    ];
    const readTool: CoderTool = {
      name: 'mcp__read_file',
      description: 'r',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: readContents[readCallNum++] ?? 'fallback', isError: false }),
    };
    const editTool: CoderTool = {
      name: 'edit_file',
      description: 'e',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'Edited src/foo.ts (1 replacement)', isError: false }),
    };
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(editTool);
    const runner = makeRunner(provider, registry);
    await runner.run();
    expect(readCallNum).toBe(2);
    const r2 = findToolResult(runner, 'r2');
    expect(r2).toBeDefined();
    expect(r2!.content).toMatch(/\[reread-after-edit\]/);
    expect(r2!.content).toMatch(/@@/); // unified-diff hunk header
    expect(r2!.content).toMatch(/LINE 2 CHANGED/);
    // is_error should be false — this is a successful re-read, just shaped.
    expect(r2!.is_error).not.toBe(true);
  });

  it('mutation has priority over elide (returns [reread-after-edit] header even when prior is elided)', async () => {
    let runnerRef: CoderRunner | null = null;
    let callCount = 0;
    const provider: ChatProvider = {
      name: 'p', model: 'm-1',
      setModel(m: string) { this.model = m; },
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call_start', id: 'r1', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r1',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts' },
          };
        } else if (callCount === 2) {
          yield { type: 'tool_call_start', id: 'e1', name: 'edit_file' };
          yield {
            type: 'tool_call_end',
            id: 'e1',
            name: 'edit_file',
            input: { path: 'src/foo.ts', old_string: 'x', new_string: 'y' },
          };
        } else if (callCount === 3) {
          if (runnerRef) {
            for (const m of getMessages(runnerRef)) {
              if (m.role !== 'tool') continue;
              m.content = m.content.map((b) =>
                b.type === 'tool_result' && b.tool_use_id === 'r1'
                  ? { ...b, content: '[duplicate-read elided] dropped' }
                  : b,
              );
            }
          }
          yield { type: 'tool_call_start', id: 'r2', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r2',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts' },
          };
        } else {
          yield { type: 'text_delta', text: 'done' };
        }
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
        yield { type: 'done' };
      },
    };
    const readTool: CoderTool = {
      name: 'mcp__read_file',
      description: 'r',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'current file content', isError: false }),
    };
    const editTool: CoderTool = {
      name: 'edit_file',
      description: 'e',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'Edited', isError: false }),
    };
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(editTool);
    runnerRef = makeRunner(provider, registry);
    await runnerRef.run();
    const r2 = findToolResult(runnerRef, 'r2');
    expect(r2).toBeDefined();
    // Mutation wins over elide: gets the reread-after-edit header (with the
    // compacted-fallback message because the prior result is no longer in
    // context, but NOT the bare "[duplicate-read elided]" path).
    expect(r2!.content).toMatch(/\[reread-after-edit\]/);
  });
});
