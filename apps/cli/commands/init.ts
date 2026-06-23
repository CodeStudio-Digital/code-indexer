import type { Command } from 'commander';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';

export function register(program: Command): void {
  program
    .command('init [dir]')
    .description('Create .mcpindexignore file for a project')
    .action(async (dir: string | undefined) => {
      const base = dir ?? process.cwd();

      // Warn if legacy config exists
      const legacyConfig = join(base, '.mcp-indexer.json');
      if (existsSync(legacyConfig)) {
        console.warn(
          '[deprecation] .mcp-indexer.json is no longer used. ' +
          'Settings are managed via the admin dashboard. You can safely delete this file.'
        );
      }

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
