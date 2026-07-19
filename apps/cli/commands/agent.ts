import type { Command } from 'commander';
import type { CoderProviderName } from '@mcp/code-agent/index.js';
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import { resolve } from 'node:path';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { resolveAgentRuntimeEnv } from '@mcp/api-handlers/runtime/runtime-resolve.js';
import { getDB, promptStdin } from '../helpers.js';

export function register(program: Command): void {
  program.command('agent [task...]')
    .description('Run the coding agent: read code, edit files, run shell, git')
    .option('-p, --provider <name>', 'Provider instance id or shape (built-in shapes listed via `mcp-code-indexer models`)', 'zai')
    .option('-m, --model <model>', 'Model name (provider-specific)')
    .option('--project <name>', 'Project name (default: resolve from cwd)')
    .option('--session <id>', 'Continue an existing session id', parseInt)
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
    .action(async (taskParts: string[], opts: { provider: string; model?: string; project?: string; session?: number; maxTurns?: number; plan?: boolean; agent?: string; profile?: string; worktree?: string | boolean; worktreeBranch?: string }) => {
      const task = (taskParts ?? []).join(' ').trim();
      if (!task) {
        console.error('Error: provide a task. Example: mcp-code-indexer agent "fix the typo in src/cli.ts"');
        process.exit(1);
      }

      const db = getDB();
      let projectId: number | undefined;

      if (opts.session) {
        const { SessionStore } = await import('@mcp/code-agent/index.js');
        const config = loadConfig();
        const store = new SessionStore(config.dbPath);
        const s = store.getSession(opts.session);
        store.close();
        if (!s) {
          console.error(`Error: session ${opts.session} not found`);
          process.exit(1);
        }
        projectId = s.project_id;
      } else {
        if (opts.project) {
          const p = db.getProjectByName(opts.project);
          if (!p) {
            console.error(`Error: project '${opts.project}' not found`);
            process.exit(1);
          }
          projectId = p.id;
        } else {
          const cwd = resolve(process.cwd());
          const all = db.listProjects();
          const match = all.find((p) => resolve(p.root_path) === cwd);
          if (!match) {
            console.error(`Error: no indexed project at ${cwd}. Pass --project <name> or run 'mcp-code-indexer index .' first.`);
            process.exit(1);
          }
          projectId = match.id;
        }
      }

      const { runCoder } = await import('@mcp/code-agent/index.js');
      const { AGENTS, isAgentId } = await import('@mcp/code-agent/agents/index.js');

      if (opts.agent && !isAgentId(opts.agent)) {
        console.error(`Error: unknown agent '${opts.agent}'. Valid: ${Object.keys(AGENTS).join(', ')}.`);
        process.exit(1);
      }
      if (opts.profile && !['bootstrap', 'navigate', 'full', 'auto'].includes(opts.profile)) {
        console.error(`Error: unknown profile '${opts.profile}'. Valid: bootstrap, navigate, full, auto.`);
        process.exit(1);
      }

      const sessionArg = opts.session
        ? ({ id: opts.session } as const)
        : ({
            create: {
              project_id: projectId!,
              title: task.slice(0, 60),
              provider: opts.provider as CoderProviderName,
              model: opts.model,
            },
          } as const);

      // --worktree takes either a name or a boolean (bare flag → auto-name).
      // Ignored on --session (resumed) runs: the worktree state is already
      // persisted and the runner rehydrates from `coder_sessions.worktree_path`.
      const worktreeOpt =
        !opts.session && opts.worktree !== undefined
          ? {
              name: typeof opts.worktree === 'string' ? opts.worktree : undefined,
              branch: opts.worktreeBranch,
            }
          : undefined;

      const handle = await runCoder({
        session: sessionArg,
        resolveRuntimeEnv: resolveAgentRuntimeEnv,
        userMessage: task,
        maxTurns: opts.maxTurns,
        planMode: opts.plan,
        agent: opts.agent as AgentId | undefined,
        profile: opts.profile as 'bootstrap' | 'navigate' | 'full' | 'auto' | undefined,
        worktree: worktreeOpt,
      });

      handle.runner.on('plan_posted', (block) => {
        void (async () => {
          process.stdout.write(`\n\n📋 PLAN:\n${block.plan}\n\n`);
          const ans = (await promptStdin('Approve plan? [y/N] ')).trim().toLowerCase();
          const approved = ans === 'y' || ans === 'yes';
          handle.runner.provideUserInput(JSON.stringify({ approved }));
        })();
      });

      handle.runner.on('tasks_posted', (payload) => {
        void (async () => {
          process.stdout.write(`\n\n📋 TASKS (${payload.tasks.length}): ${payload.summary}\n`);
          for (const t of payload.tasks) {
            const deps = t.depends_on.length > 0 ? ` (after: ${t.depends_on.join(', ')})` : '';
            process.stdout.write(`  - ${t.id} [${t.suggested_mode}/${t.estimated_complexity}]${deps}: ${t.title}\n`);
            process.stdout.write(`      files: ${t.files.join(', ') || '(none)'}\n`);
          }
          const ans = (await promptStdin('\nApprove tasks? [y/N] ')).trim().toLowerCase();
          const approved = ans === 'y' || ans === 'yes';
          let execution_mode: 'inline' | 'all-subagent' | 'smart' | 'per-task' = 'inline';
          if (approved) {
            const modeAns = (
              await promptStdin('Execution mode? [i=inline | s=all-subagent | m=smart] (default i) ')
            ).trim().toLowerCase();
            if (modeAns === 's' || modeAns === 'subagent' || modeAns === 'all-subagent') execution_mode = 'all-subagent';
            else if (modeAns === 'm' || modeAns === 'smart') execution_mode = 'smart';
          }
          handle.runner.provideUserInput(
            JSON.stringify({ approved, execution_mode })
          );
        })();
      });

      handle.runner.on('task_started', (payload) => {
        process.stdout.write(`\n  ▶ task_started ${payload.task_id} (${payload.mode})\n`);
      });
      handle.runner.on('task_finished', (payload) => {
        process.stdout.write(`\n  ✓ task_finished ${payload.task_id} (${payload.status})\n`);
      });

      handle.runner.on('question_posted', (block) => {
        void (async () => {
          process.stdout.write(`\n\n❓ ${block.question}\n`);
          if (block.options?.length) {
            block.options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o.label}\n`));
          }
          const ans = await promptStdin('> ');
          let answer = ans.trim();
          if (block.options?.length) {
            const n = parseInt(answer, 10);
            if (n >= 1 && n <= block.options.length) answer = block.options[n - 1].value;
          }
          handle.runner.provideUserInput(JSON.stringify({ answer }));
        })();
      });

      console.log(`\n  session #${handle.session.id} (${handle.session.provider}/${handle.session.model})`);
      console.log(`  project: ${db.getProject(handle.session.project_id)?.name}\n`);

      handle.runner.on('text_delta', (t) => process.stdout.write(t));
      handle.runner.on('tool_call_start', (id, name, input) => {
        const args = JSON.stringify(input);
        const short = args.length > 120 ? args.slice(0, 120) + '…' : args;
        process.stdout.write(`\n  ⚙ ${name} ${short}\n`);
      });
      handle.runner.on('tool_call_result', (_id, _name, result, ms) => {
        const prefix = result.isError ? '  ✖' : '  ✓';
        const preview = result.content.split('\n').slice(0, 3).join('\n');
        process.stdout.write(`${prefix} (${ms}ms) ${preview.length > 200 ? preview.slice(0, 200) + '…' : preview}\n\n`);
      });
      handle.runner.on('done', (reason, error) => {
        process.stdout.write(`\n\n[done: ${reason}${error ? ' — ' + error.message : ''}]\n`);
      });

      const result = await handle.done;
      console.log(`tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`);
      process.exit(0);
    });
}
