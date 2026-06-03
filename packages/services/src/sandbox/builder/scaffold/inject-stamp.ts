/**
 * Writes a `SourceStampPlugin`'s files into the sandbox workdir and appends
 * the dev-only inspector import to the app entry. Idempotent: re-running
 * (e.g. a retry) won't double-append the entry import.
 */
import type { ISandboxDriver } from '../../ports/sandbox-driver.js';
import type { SourceStampPlugin } from '../source-stamp/types.js';

export interface InjectStampDeps {
  driver: ISandboxDriver;
  containerId: string;
  /** Absolute container workdir, e.g. `/app`. */
  workdir: string;
}

const MARKER = 'mcp-inspector';

export async function injectSourceStamp(
  plugin: SourceStampPlugin,
  deps: InjectStampDeps,
): Promise<void> {
  const { driver, containerId, workdir } = deps;
  const { files, entry } = plugin.contribution();

  // 1. Write every stamp file (babel plugin, inspector runtime). `recursive`
  //    creates parent dirs like `.mcp/` and `src/`.
  for (const file of files) {
    await driver.writeFile(containerId, `${workdir}/${file.path}`, file.contents, {
      recursive: true,
    });
  }

  // 2. Append the dev-only inspector import to the entry — once. Read the
  //    current entry, skip if the marker is already present.
  const entryPath = `${workdir}/${entry.file}`;
  let current = '';
  try {
    current = await driver.readFile(containerId, entryPath);
  } catch {
    // Entry missing (unexpected for a Vite template) — nothing to append to.
    return;
  }
  if (current.includes(MARKER)) return;
  const next = `${current.replace(/\s*$/, '')}\n\n${entry.importLine}\n`;
  await driver.writeFile(containerId, entryPath, next, { recursive: true });
}
