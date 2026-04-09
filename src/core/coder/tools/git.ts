import { spawnSync } from 'node:child_process';
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import {
  GIT_STATUS_DESC,
  GIT_DIFF_DESC,
  GIT_LOG_DESC,
  GIT_ADD_DESC,
  GIT_COMMIT_DESC,
  GIT_BRANCH_DESC,
  maybeTerse,
} from './descriptions.js';

function git(args: string[], ctx: ToolContext): ToolResult {
  const r = spawnSync('git', args, { cwd: ctx.cwd, encoding: 'utf-8' });
  if (r.error) return err(`git ${args.join(' ')} failed to spawn: ${r.error.message}`);
  const out = (r.stdout ?? '').trim();
  const errOut = (r.stderr ?? '').trim();
  if (r.status !== 0) {
    return err([`git ${args.join(' ')} exited ${r.status}`, errOut, out].filter(Boolean).join('\n'));
  }
  return ok(out || '(no output)');
}

const gitStatus: CoderTool = {
  name: 'git_status',
  description: maybeTerse(GIT_STATUS_DESC),
  source: 'native',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => git(['status', '--short'], ctx),
};

const gitDiff: CoderTool = {
  name: 'git_diff',
  description: maybeTerse(GIT_DIFF_DESC),
  source: 'native',
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
    return git(['commit', '-m', message], ctx);
  },
};

const gitBranch: CoderTool = {
  name: 'git_branch',
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
