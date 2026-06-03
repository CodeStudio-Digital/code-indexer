/**
 * Targeted module stubs — before typechecking a candidate, declare `any` for
 * the imports it uses that DON'T resolve in the sandbox (a hallucinated
 * `@/components/ui/foo`, or a lib that wasn't installed). This stops a single
 * bad import from failing an otherwise-good candidate, WITHOUT weakening type
 * checks for the real shadcn components that DO exist.
 */
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STUB_REL = 'src/__stubs__.d.ts';
const IMPORT_RE = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;

function specifiers(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) out.add(spec);
  }
  return [...out];
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Does `spec` resolve inside the sandbox? */
async function resolves(sandboxDir: string, spec: string): Promise<boolean> {
  if (spec.startsWith('@/')) {
    const base = join(sandboxDir, 'src', spec.slice(2));
    for (const cand of [`${base}.tsx`, `${base}.ts`, `${base}.d.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
      if (await exists(cand)) return true;
    }
    return false;
  }
  if (spec.startsWith('.')) return true; // relative — leave to tsc (rare in single-file output)
  // bare / scoped package
  return exists(join(sandboxDir, 'node_modules', spec));
}

/**
 * Write `src/__stubs__.d.ts` declaring `any` for unresolved specifiers.
 * Returns the stub file path if anything was stubbed, else null.
 */
export async function writeMissingModuleStubs(sandboxDir: string, code: string): Promise<string | null> {
  const missing: string[] = [];
  for (const spec of specifiers(code)) {
    if (!(await resolves(sandboxDir, spec))) missing.push(spec);
  }
  const stubPath = join(sandboxDir, STUB_REL);
  if (missing.length === 0) return null;
  const body = missing.map((s) => `declare module '${s}';`).join('\n') + '\n';
  await writeFile(stubPath, body, 'utf-8');
  return stubPath;
}
