import type { Command } from 'commander';
import { asSessionId } from '@mcp/session-storage';
import type { AgentCliOptions } from './agent-session-client.js';

export function register(program: Command): void {
  program.command('agent [task...]')
    .description('Run the coding agent: read code, edit files, run shell, git')
    .option('-p, --provider <name>', 'Provider instance id or shape (built-in shapes listed via `mcp-code-indexer models`)', 'zai')
    .option('-m, --model <model>', 'Model name (provider-specific)')
    .option('--project <name>', 'Project name (default: resolve from cwd)')
    .option(
      '--session <uuid>',
      'Continue an existing filesystem session UUID',
      (value: string) => asSessionId(value),
    )
    .option('--max-turns <n>', 'Max turns (default 50)', parseInt)
    .option('--plan', 'Plan mode: agent must submit a plan and get user approval before mutating tools')
    .option(
      '--agent <id>',
      'Agent preset: explore (repo read-only) | research (web research) | plan (read + plan mode) | build (read+edit) | admin (everything). Default: auto by first message',
    )
    .option(
      '--profile <id>',
      'Tool tier profile: bootstrap | navigate | full | auto. Overrides --agent profile when both set',
    )
    .option(
      '--worktree [name]',
      'Run the session inside an isolated git worktree under .mcp-indexer/worktrees/<name>/. Pass a name or leave blank for an auto-generated one. Ignored on --session (resumed) runs.',
    )
    .option(
      '--worktree-branch <branch>',
      'When --worktree is set, check out this branch inside the worktree (default: coder/<name>). Created from HEAD if missing.',
    )
    .action(async (taskParts: string[], opts: AgentCliOptions) => {
      const task = (taskParts ?? []).join(' ').trim();
      if (!task) {
        console.error('Error: provide a task. Example: mcp-code-indexer agent "fix the typo in src/cli.ts"');
        process.exitCode = 1;
        return;
      }
      try {
        const { runAgentCommand } = await import('./agent-command.js');
        process.exitCode = await runAgentCommand(task, opts);
      } catch (error) {
        console.error(`\n[done: error — ${error instanceof Error ? error.message : String(error)}]`);
        process.exitCode = 1;
      }
    });
}
