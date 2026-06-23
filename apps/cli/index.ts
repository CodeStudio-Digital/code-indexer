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

program.parse();
