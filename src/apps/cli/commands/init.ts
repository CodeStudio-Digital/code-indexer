import type { Command } from 'commander';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { getDefaultConfigTemplate } from '../../../utils/config.js';
import { runInitWizard } from '../wizard.js';
import type { InitOverrides } from '../../../utils/config.js';

export function register(program: Command): void {
  program
    .command('init [dir]')
    .description('Create default config file and .mcpindexignore')
    .option('-i, --interactive', 'Run an interactive wizard to choose description, provider, model and embeddings')
    .option('-y, --yes', 'Accept DB-backed defaults without prompting (useful with --interactive in CI)')
    .action(async (dir: string | undefined, opts: { interactive?: boolean; yes?: boolean }) => {
      const base = dir ?? process.cwd();
      const configTarget = join(base, '.mcp-indexer.json');

      let overrides: InitOverrides = {};
      if (opts.interactive) {
        overrides = await runInitWizard(opts.yes === true);
      }

      writeFileSync(configTarget, getDefaultConfigTemplate(overrides), 'utf-8');
      console.log(`Config created: ${configTarget}`);

      const ignoreTarget = join(base, '.mcpindexignore');
      if (!existsSync(ignoreTarget)) {
        const defaultIgnore = [
          '# MCP Code Indexer — files and folders to exclude from indexing',
          '# Uses the same syntax as .gitignore',
          '',
          '# Dependencies',
          'node_modules/',
          'vendor/',
          '.venv/',
          '',
          '# Build output',
          'dist/',
          'build/',
          'out/',
          '.next/',
          '.nuxt/',
          '',
          '# Tests (uncomment to skip test files)',
          '# *.test.*',
          '# *.spec.*',
          '# __tests__/',
          '',
          '# Generated files',
          '# *.generated.*',
          '# *.g.dart',
          '',
          '# Large / binary assets',
          '*.min.js',
          '*.min.css',
          '*.map',
          '*.bundle.js',
          '',
          '# IDE / OS',
          '.vscode/',
          '.idea/',
          '.DS_Store',
          'Thumbs.db',
          '',
          '# Secrets',
          '.env',
          '.env.*',
          '*.pem',
          '*.key',
          '',
        ].join('\n');
        writeFileSync(ignoreTarget, defaultIgnore, 'utf-8');
        console.log(`.mcpindexignore created: ${ignoreTarget}`);
      } else {
        console.log(`.mcpindexignore already exists: ${ignoreTarget}`);
      }
    });
}
