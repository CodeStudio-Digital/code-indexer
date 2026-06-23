/**
 * UI build step: plugin webviews render as NULL-ORIGIN iframes (srcDoc, no
 * `allow-same-origin`), so the final HTML must be fully self-contained — no
 * external <script src> / <link href> will ever load. This step lets authors
 * still write modular TS/CSS: every `*.template.html` under `ui/` has its
 * RELATIVE script/stylesheet refs bundled (esbuild, iife/browser) inlined, and the
 * result is emitted next to it without the `.template` suffix (the artifact a
 * tool window's `entry` points at). Absolute/`https:` refs are left intact.
 * Plugins without templates build exactly as before.
 */
import { build as esbuild } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface UiBuildResult {
  /** Absolute paths of the emitted (inlined) HTML files. */
  written: string[];
}

const TEMPLATE_SUFFIX = '.template.html';
const SCRIPT_TAG = /<script\s[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;
const LINK_TAG = /<link\s[^>]*>/gi;
const HREF_ATTR = /\bhref\s*=\s*["']([^"']+)["']/i;
const REL_STYLESHEET = /\brel\s*=\s*["']stylesheet["']/i;

/** Only `./x`, `../x` or bare `x` paths are ours to inline. */
function isRelativeRef(ref: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('/');
}

/** Recursively collect `*.template.html` under `ui/` (tiny tree, no glob dep). */
async function findTemplates(uiDir: string): Promise<string[]> {
  if (!existsSync(uiDir)) return [];
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(TEMPLATE_SUFFIX)) out.push(p);
    }
  };
  await walk(uiDir);
  return out;
}

async function bundle(entry: string, loader: 'js' | 'css'): Promise<string> {
  const r = await esbuild({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: loader === 'js' ? 'iife' : undefined,
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
  });
  return r.outputFiles[0]?.text ?? '';
}

/** `</script>`/`</style>` inside the bundle would close the inline tag early;
 *  `<\/...>` is byte-identical in JS strings and an escaped `/` in CSS. */
function escapeInline(code: string, kind: 'script' | 'style'): string {
  return kind === 'script'
    ? code.replace(/<\/script/gi, '<\\/script')
    : code.replace(/<\/style/gi, '<\\/style');
}

async function inlineTemplate(templatePath: string): Promise<string> {
  const baseDir = dirname(templatePath);
  let html = await readFile(templatePath, 'utf8');

  // Scripts: <script src="./src/panel.ts"></script> → inline iife bundle.
  for (const m of [...html.matchAll(SCRIPT_TAG)]) {
    const [tag, src] = m;
    if (!isRelativeRef(src)) continue;
    const entry = resolve(baseDir, src);
    if (!existsSync(entry)) throw new Error(`ui template ${templatePath}: missing script ${src}`);
    const js = escapeInline(await bundle(entry, 'js'), 'script');
    html = html.replace(tag, () => `<script>\n${js}</script>`);
  }

  // Stylesheets: <link rel="stylesheet" href="./panel.css"> → inline <style>.
  for (const m of [...html.matchAll(LINK_TAG)]) {
    const tag = m[0];
    if (!REL_STYLESHEET.test(tag)) continue;
    const href = HREF_ATTR.exec(tag)?.[1];
    if (!href || !isRelativeRef(href)) continue;
    const entry = resolve(baseDir, href);
    if (!existsSync(entry)) throw new Error(`ui template ${templatePath}: missing stylesheet ${href}`);
    const css = escapeInline(await bundle(entry, 'css'), 'style');
    html = html.replace(tag, () => `<style>\n${css}</style>`);
  }

  return html;
}

/** Build every UI template under `<root>/ui` into its self-contained HTML. */
export async function buildPluginUi(root: string): Promise<UiBuildResult> {
  const written: string[] = [];
  for (const tpl of await findTemplates(join(root, 'ui'))) {
    const out = tpl.slice(0, -TEMPLATE_SUFFIX.length) + '.html';
    await writeFile(out, await inlineTemplate(tpl));
    written.push(out);
  }
  return { written };
}
