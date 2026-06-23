import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePluginManifest, parseAppManifest } from '../manifest/schema.js';

export interface ValidateIssue {
  message: string;
}

/** Validate a plugin dir: manifest schemas + referenced assets + no TODOs. */
export async function validatePlugin(dir: string): Promise<ValidateIssue[]> {
  const root = resolve(dir);
  const issues: ValidateIssue[] = [];

  const rawText = await readFile(join(root, 'plugin.json'), 'utf8').catch(() => null);
  if (rawText === null) return [{ message: `no plugin.json in ${root}` }];

  let manifest;
  try {
    manifest = parsePluginManifest(JSON.parse(rawText));
  } catch (e) {
    return [{ message: `plugin.json: ${e instanceof Error ? e.message : String(e)}` }];
  }
  if (/\[TODO:/.test(rawText)) {
    issues.push({ message: 'plugin.json contains [TODO: ...] placeholders' });
  }

  const appPath = manifest.apps ? join(root, manifest.apps) : join(root, '.app.json');
  if (existsSync(appPath)) {
    try {
      const app = parseAppManifest(JSON.parse(await readFile(appPath, 'utf8')));
      for (const w of app.toolWindows ?? []) {
        if (!existsSync(join(root, w.entry))) {
          const template = w.entry.replace(/\.html$/, '.template.html');
          const hint = existsSync(join(root, template)) ? ' (run build to inline the template)' : '';
          issues.push({ message: `tool window "${w.id}" entry missing: ${w.entry}${hint}` });
        }
      }
      if (app.worker && !existsSync(join(root, app.worker))) {
        issues.push({ message: `worker bundle missing: ${app.worker} (run build)` });
      }
    } catch (e) {
      issues.push({ message: `.app.json: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const iface = manifest.interface;
  if (iface) {
    for (const [field, p] of [
      ['composerIcon', iface.composerIcon],
      ['logo', iface.logo],
    ] as const) {
      if (p && !existsSync(join(root, p))) {
        issues.push({ message: `interface.${field} missing: ${p}` });
      }
    }
    for (const s of iface.screenshots ?? []) {
      if (!existsSync(join(root, s))) issues.push({ message: `screenshot missing: ${s}` });
    }
  }

  return issues;
}
