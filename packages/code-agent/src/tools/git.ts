import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import {
  GIT_STATUS_DESC,
  GIT_DIFF_DESC,
  GIT_LOG_DESC,
  GIT_ADD_DESC,
  GIT_COMMIT_DESC,
  GIT_BRANCH_DESC,
  maybeTerse,
} from '@mcp/code-agent/tools/descriptions.js';

async function git(args: string[], ctx: ToolContext): Promise<ToolResult> {
  const shell = ctx.ports?.shell ?? defaultLocalShellPort();
  const r = await shell.run('git', args, { cwd: ctx.cwd, encoding: 'utf-8' });
  // `run()` surfaces spawn errors via stderr+exitCode=null, matching the
  // pre-refactor spawnSync branch that reported `r.error.message`.
  if (r.exitCode === null && !r.stdout && r.stderr) {
    return err(r.stderr);
  }
  const out = (r.stdout ?? '').trim();
  const errOut = (r.stderr ?? '').trim();
  if (r.exitCode !== 0) {
    return err([`git ${args.join(' ')} exited ${r.exitCode}`, errOut, out].filter(Boolean).join('\n'));
  }
  return ok(out || '(no output)');
}

/** Add public bot co-authorship only for commits created by the code agent. */
export function withManagedCommitAttribution(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.MEGABRAIN_GIT_IDENTITY_DEFAULT !== 'managed' || env.MEGABRAIN_GIT_PUBLIC_ATTRIBUTION === '0') {
    return message;
  }
  const botId = (env.MEGABRAIN_GITHUB_BOT_USER_ID || '306376051').trim();
  const botLogin = (env.MEGABRAIN_GITHUB_BOT_LOGIN || 'megabrainstudio[bot]').trim();
  if (!/^\d+$/.test(botId) || !/^[A-Za-z0-9_.-]+\[bot\]$/.test(botLogin)) return message;
  const email = `${botId}+${botLogin}@users.noreply.github.com`;
  if (message.toLowerCase().includes(email.toLowerCase())) return message;
  return `${message}\n\nCo-authored-by: MegaBrainStudio <${email}>`;
}

const gitStatus: CoderTool = {
  name: 'git_status',
  effectBoundary: 'shell',
  description: maybeTerse(GIT_STATUS_DESC),
  source: 'native',
  repeatPolicy: 'volatile',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => git(['status', '--short'], ctx),
};

const gitDiff: CoderTool = {
  name: 'git_diff',
  effectBoundary: 'shell',
  description: maybeTerse(GIT_DIFF_DESC),
  source: 'native',
  repeatPolicy: 'volatile',
  parameters: {
    type: 'object',
    properties: {
      staged: { type: 'boolean', description: 'Show staged diff (default false)' },
      path: { type: 'string', description: 'Optional path filter' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const cmd = ['diff'];
    if (args.staged) cmd.push('--staged');
    if (args.path) cmd.push('--', String(args.path));
    return git(cmd, ctx);
  },
};

const gitLog: CoderTool = {
  name: 'git_log',
  effectBoundary: 'shell',
  description: maybeTerse(GIT_LOG_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max commits (default 10)' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    return git(['log', `-${limit}`, '--oneline', '--decorate'], ctx);
  },
};

const gitAdd: CoderTool = {
  name: 'git_add',
  effectBoundary: 'shell',
  description: maybeTerse(GIT_ADD_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Paths to stage' },
    },
    required: ['paths'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
    if (paths.length === 0) return err('paths cannot be empty');
    return git(['add', ...paths], ctx);
  },
};

const gitCommit: CoderTool = {
  name: 'git_commit',
  effectBoundary: 'shell',
  description: maybeTerse(GIT_COMMIT_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message' },
    },
    required: ['message'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const message = String(args.message ?? '').trim();
    if (!message) return err('message cannot be empty');
    return git(['commit', '-m', withManagedCommitAttribution(message)], ctx);
  },
};

const gitBranch: CoderTool = {
  name: 'git_branch',
  effectBoundary: 'shell',
  description: maybeTerse(GIT_BRANCH_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      show_current: { type: 'boolean', description: 'Show only the current branch' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.show_current) return git(['branch', '--show-current'], ctx);
    return git(['branch', '--list'], ctx);
  },
};

export const gitTools: CoderTool[] = [gitStatus, gitDiff, gitLog, gitAdd, gitCommit, gitBranch];

/** Synthetic union roots are not repositories; ordinary projects stay unchanged. */
export function gitToolsForProject(isSynthetic: boolean): CoderTool[] {
  return isSynthetic ? [] : gitTools;
}
