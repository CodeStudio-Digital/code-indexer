/**
 * Codegen intermediate. A CodegenRequest is POST-everything: URL resolved (or
 * template), headers already include auth (folded by build-request), body fully
 * decided. Generators are dumb serializers — they never re-resolve {{var}} and
 * never know auth types.
 */
export type CodegenTarget =
  | 'curl-bash' | 'curl-cmd' | 'powershell' | 'httpie'
  | 'js-fetch' | 'node' | 'python';

export interface CodegenHeader { name: string; value: string; }

export type CodegenBody =
  | { kind: 'none' }
  | { kind: 'json'; content: string }
  | { kind: 'raw'; content: string; contentType?: string }
  | { kind: 'urlencoded'; fields: Array<[string, string]> }
  | { kind: 'form-data'; fields: Array<{ name: string; value: string; filename?: string }> }
  | { kind: 'graphql'; query: string; variables?: string }
  | { kind: 'binary'; note: string };

export interface CodegenRequest {
  method: string;
  url: string;
  headers: CodegenHeader[];
  body: CodegenBody;
}

export interface CodegenResult {
  target: CodegenTarget;
  language: string;
  code: string;
}

export interface TargetMeta {
  target: CodegenTarget;
  label: string;
  /** Monaco language id for the read-only viewer. */
  language: string;
}

export const TARGET_META: TargetMeta[] = [
  { target: 'curl-bash', label: 'cURL (bash)', language: 'shell' },
  { target: 'curl-cmd', label: 'cURL (cmd)', language: 'bat' },
  { target: 'powershell', label: 'PowerShell', language: 'powershell' },
  { target: 'httpie', label: 'HTTPie', language: 'shell' },
  { target: 'js-fetch', label: 'JavaScript (fetch)', language: 'javascript' },
  { target: 'node', label: 'Node.js', language: 'javascript' },
  { target: 'python', label: 'Python (requests)', language: 'python' },
];
