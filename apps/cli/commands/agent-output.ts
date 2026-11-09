type OutputWriter = (chunk: string) => void;
interface AgentToolEventSource {
  on(event: 'tool_call_result', listener: (id: string, name: string, result: { content: string; isError?: boolean }, durationMs: number) => void): unknown;
}

function preview(content: string): string {
  const firstLines = content.split('\n').slice(0, 3).join('\n');
  return firstLines.length > 200 ? `${firstLines.slice(0, 200)}…` : firstLines;
}

export function wireAgentToolOutput(runner: AgentToolEventSource, write: OutputWriter): void {
  runner.on('tool_call_result', createAgentToolOutput(write).result);
}

export function createAgentToolOutput(write: OutputWriter) {
  return {
    result(_id: string, _name: string, result: { content: string; isError?: boolean }, durationMs: number): void {
      write(`  ${result.isError ? '✖' : '✓'} (${durationMs}ms) ${preview(result.content)}\n\n`);
    },
  };
}
