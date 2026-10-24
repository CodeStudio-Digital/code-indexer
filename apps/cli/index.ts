#!/usr/bin/env node

import { Command } from 'commander';
import { registerAll } from './commands/index.js';
import { VERSION, PACKAGE_NAME } from '@mcp/shared/version.js';

const program = new Command();

program
  .name(PACKAGE_NAME)
  .description('Codebase indexing platform powered by LLMs')
  .version(VERSION);

registerAll(program);

// This entry point is always a Node-style script, including Electron's Node
// runtime. Commander otherwise mistakes the script path for a user command.
await program.parseAsync(process.argv, { from: 'node' });
