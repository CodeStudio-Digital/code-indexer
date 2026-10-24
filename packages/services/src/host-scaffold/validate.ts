/**
 * Input validation for a scaffold request. Runs BEFORE any child process
 * spawns. The repo-URL allowlist is a security boundary: the URL becomes a
 * positional `git clone` argument, so we reject anything that could be
 * read as a flag (`--upload-pack=…`) or an unexpected scheme.
 */
import { isTemplateId } from './templates/registry.js';
import type { TemplateId } from './templates/types.js';

export interface ScaffoldInput {
  template: TemplateId;
  name: string;
  description?: string;
  repoUrl?: string;
  gitInit?: boolean;
  /**
   * Builder mode — after the normal scaffold, bake in Tailwind + shadcn +
   * the element-selection source-stamp and mark the project as a builder
   * project. Only valid for `react-vite` today.
   */
  builder?: boolean;
}

export class ScaffoldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldValidationError';
  }
}

// https://… | ssh://… | git@host:path — and never a leading dash.
const REPO_URL_RE = /^(https:\/\/|ssh:\/\/|git@[^/\s]+:)[^\s]+$/;

/** Validate + normalize a raw request body. Throws on bad input. */
export function validateScaffoldInput(body: unknown): ScaffoldInput {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isTemplateId(b.template)) {
    throw new ScaffoldValidationError(`Unknown or missing template: ${String(b.template)}`);
  }
  const template = b.template;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new ScaffoldValidationError('Project name is required');
  if (name.length > 120) throw new ScaffoldValidationError('Project name is too long');

  let repoUrl: string | undefined;
  if (template === 'git-clone') {
    repoUrl = typeof b.repoUrl === 'string' ? b.repoUrl.trim() : '';
    if (!repoUrl) throw new ScaffoldValidationError('A repository URL is required to clone');
    if (repoUrl.startsWith('-') || !REPO_URL_RE.test(repoUrl)) {
      throw new ScaffoldValidationError('Repository URL must be an https://, ssh://, or git@ URL');
    }
  }

  const description = typeof b.description === 'string' ? b.description.trim() : undefined;
  const gitInit = b.gitInit === true;
  // Builder is only meaningful for the React+Vite template (the only stack
  // with a source-stamp plugin today).
  const builder = b.builder === true && template === 'react-vite';
  return { template, name, description, repoUrl, gitInit, builder };
}
