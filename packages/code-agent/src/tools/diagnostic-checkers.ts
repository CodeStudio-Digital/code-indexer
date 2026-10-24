import { extname } from 'node:path';

export type DiagnosticLanguage = 'ts' | 'py' | 'go' | 'rs' | 'php';

export function diagnosticLanguage(file: string): DiagnosticLanguage | undefined {
  const ext = extname(file).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(ext)) return 'ts';
  const languages: Record<string, DiagnosticLanguage> = { '.py': 'py', '.go': 'go', '.rs': 'rs', '.php': 'php' };
  return languages[ext];
}

/** Shared with the mutation binding: fixed executables, never user commands. */
export function diagnosticExecutables(file: string): string[] {
  switch (diagnosticLanguage(file)) {
    case 'ts': return ['node'];
    case 'py': return ['ruff', 'python'];
    case 'go': return ['go'];
    case 'rs': return ['cargo'];
    case 'php': return ['php'];
    default: return [];
  }
}

// Parse without importing user code or leaving __pycache__ files in the project.
export const PYTHON_SYNTAX_CHECK = 'import ast,sys,tokenize\nwith tokenize.open(sys.argv[1]) as source:\n ast.parse(source.read(), filename=sys.argv[1])\nprint("OK: Python syntax valid.")';
