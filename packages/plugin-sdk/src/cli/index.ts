#!/usr/bin/env node
/**
 * @mcp/plugin-sdk CLI. Run via tsx in dev:
 *   tsx packages/plugin-sdk/src/cli/index.ts <create|validate|build|publish> [arg]
 */
import { createPlugin } from './create-plugin.js';
import { validatePlugin } from './validate.js';
import { buildPlugin } from './build.js';
import { publishPlugin } from './publish.js';

const USAGE = 'usage: mcp-plugin <create|validate|build|publish> [name|dir]';

async function main(argv: string[]): Promise<void> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case 'create': {
      if (!arg) throw new Error('usage: create <name>');
      console.log(`Created plugin at ${await createPlugin(arg)}`);
      return;
    }
    case 'validate': {
      const issues = await validatePlugin(arg ?? '.');
      if (issues.length === 0) {
        console.log('OK — no issues');
        return;
      }
      for (const i of issues) console.error(`x ${i.message}`);
      process.exitCode = 1;
      return;
    }
    case 'build': {
      const r = await buildPlugin(arg ?? '.');
      console.log(`Built ${r.tools} tool(s) -> ${r.bundle}; wrote ${r.appJson}`);
      return;
    }
    case 'publish': {
      const r = await publishPlugin(arg ?? '.');
      console.log(`Published ${r.name}@${r.version}`);
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
