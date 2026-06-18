/**
 * Codegen registry — map a target to its generator. Generators are pure and
 * operate on a CodegenRequest (built by build-request.ts).
 */
import { generateCurl } from './curl.js';
import { generatePowerShell } from './powershell.js';
import { generateHttpie } from './http.js';
import { generateJs } from './js.js';
import { generatePython } from './python.js';
import { TARGET_META, type CodegenRequest, type CodegenTarget } from './types.js';

const GENERATORS: Record<CodegenTarget, (r: CodegenRequest) => string> = {
  'curl-bash': (r) => generateCurl(r, 'bash'),
  'curl-cmd': (r) => generateCurl(r, 'cmd'),
  powershell: generatePowerShell,
  httpie: generateHttpie,
  'js-fetch': (r) => generateJs(r, 'fetch'),
  node: (r) => generateJs(r, 'node'),
  python: generatePython,
};

export function isCodegenTarget(t: string): t is CodegenTarget {
  return t in GENERATORS;
}

export function generate(target: CodegenTarget, req: CodegenRequest): string {
  return GENERATORS[target](req);
}

export function languageFor(target: CodegenTarget): string {
  return TARGET_META.find((m) => m.target === target)?.language ?? 'plaintext';
}

export { buildCodegenRequest } from './build-request.js';
export { TARGET_META } from './types.js';
export type { CodegenTarget, CodegenRequest, CodegenResult } from './types.js';
