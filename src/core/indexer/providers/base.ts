import type { AnalysisResult, LLMFileAnalysis, LLMSymbol, SymbolKind } from '../../../types.js';

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  analyzeFile(filePath: string, content: string): Promise<AnalysisResult>;
}

export const SYSTEM_PROMPT = `You are a code analysis engine. Analyze the provided source file and return a JSON object with the following structure. Return ONLY valid JSON, no markdown, no explanation.

{
  "language": "string - programming language",
  "summary": "string - concise description of what this file does (1-3 sentences)",
  "concepts": ["string array - domain concepts, patterns, and technologies used"],
  "dependencies": ["string array - all imports/requires (module names)"],
  "internal_deps": ["string array - imports from the same project (relative paths)"],
  "external_deps": ["string array - imports from external packages"],
  "notes": ["string array - important observations, TODOs, potential issues"],
  "complexity": "low | medium | high | very-high",
  "layer": "presentation | business | data | infrastructure | config | test | unknown",
  "is_entry_point": "boolean - true if this is a main entry point (e.g. index.ts, main.py, app startup, CLI entrypoint)",
  "is_test": "boolean - true if this is a test/spec file",
  "is_generated": "boolean - true if this file appears to be auto-generated",
  "symbols": [
    {
      "name": "string - symbol name",
      "kind": "function | class | interface | enum | constant | type | method | property | variable | module | namespace | other",
      "signature": "string - full signature including parameters and return type",
      "parent": "string | null - parent class/interface/namespace name if nested",
      "extends": "string | null - parent class/interface name if this class/interface extends another",
      "implements": ["string array - interfaces/protocols this class implements (empty if none)"],
      "modifiers": ["string array - public, private, protected, static, async, export, abstract, etc"],
      "return_type": "string | null - return type if applicable",
      "parameters": "string | null - parameter list as string",
      "line": "number | null - line number in the source file",
      "comment": "string | null - semantic description of what this symbol does",
      "tags": ["string array - categorization tags like entry-point, handler, utility, hook, middleware, route, test, etc"]
    }
  ],
  "references": [
    {
      "symbol_name": "string - name of a symbol from another file that this file uses/calls",
      "kind": "function | class | interface | type | method | other",
      "line": "number | null - line number where this symbol is used in the current file (the call site)",
      "snippet": "string | null - the full source line where this symbol is used (max 120 chars, raw text from the file)"
    }
  ]
}

Guidelines:
- For config files (JSON, YAML, TOML), focus on what the config controls
- For SQL files, describe tables, views, and operations
- For markdown/docs, summarize the document topic and sections
- Extract ALL meaningful symbols: classes, functions, methods, interfaces, enums, type aliases, exported constants
- For methods inside classes, set "parent" to the class name
- "tags" should help categorize the symbol's role in the codebase
- Keep summaries concise but informative
- Concepts should be high-level domain terms, not implementation details
- In "references", list symbols from OTHER files that this file imports and uses. Do not list symbols defined in this file. For each reference, include the line number of the FIRST call site and a short snippet of that exact line.
- "extends" and "implements" only apply to classes and interfaces. Leave null/empty for other symbol kinds.

Complexity guidelines:
- "low": < 3 code paths, < 2 nesting levels, < 3 dependencies
- "medium": 3-10 code paths, 2-3 nesting levels, 3-8 dependencies
- "high": 10-25 code paths, 4+ nesting levels, 8-15 dependencies
- "very-high": 25+ code paths OR deeply nested OR 15+ dependencies

Layer classification:
- "presentation": UI components, views, templates, CSS, frontend routing
- "business": domain logic, services, use cases, validation rules
- "data": database schemas, models, repositories, migrations, ORMs
- "infrastructure": servers, middleware, configs, adapters, external service clients
- "config": configuration files (JSON, YAML, TOML, env)
- "test": test files, specs, fixtures, mocks
- "unknown": cannot determine`;

export function buildUserPrompt(filePath: string, content: string): string {
  const maxChars = 50000;
  const truncated = content.length > maxChars
    ? content.slice(0, maxChars) + '\n\n... [truncated]'
    : content;

  const hints = getLanguageHints(filePath);
  const hintSection = hints ? `\n\n${hints}` : '';

  return `File: ${filePath}${hintSection}\n\n${truncated}`;
}

export function getLanguageHints(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const hints: Record<string, string> = {
    py: 'Python-specific: Look for decorators (@property, @staticmethod, @dataclass), __init__/__str__ methods, async def, type hints, dataclasses.',
    go: 'Go-specific: Look for receiver functions (methods on types), package declarations, goroutines (go keyword), defer statements, interface satisfaction.',
    rs: 'Rust-specific: Look for traits, impl blocks, derive macros (#[derive(...)]), lifetime annotations, unsafe blocks, async/.await.',
    java: 'Java-specific: Look for annotations (@Override, @Autowired), generics, checked exceptions, abstract classes, interface implementations.',
    ts: 'TypeScript-specific: Look for type guards, decorators, namespaces, generics, utility types, declaration files (.d.ts).',
    tsx: 'TypeScript/React-specific: Look for components (function/class), hooks (use*), JSX elements, type guards, generics.',
    kt: 'Kotlin-specific: Look for data classes, sealed classes, extension functions, coroutines (suspend), companion objects.',
    swift: 'Swift-specific: Look for protocols, extensions, optionals, property wrappers (@State, @Binding), actors, async/await.',
    rb: 'Ruby-specific: Look for modules, mixins (include/extend), blocks/procs, metaprogramming, attr_accessor/attr_reader.',
    cs: 'C#-specific: Look for attributes ([HttpGet]), generics, LINQ, async/await, interfaces, properties, records.',
  };
  return hints[ext] ?? '';
}

export function parseAnalysisResponse(raw: string, filePath: string): LLMFileAnalysis {
  // Try direct JSON parse
  try {
    return validateAnalysis(JSON.parse(raw), filePath);
  } catch { /* continue */ }

  // Try extracting from markdown code blocks
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return validateAnalysis(JSON.parse(codeBlockMatch[1]), filePath);
    } catch { /* continue */ }
  }

  // Try finding first balanced JSON object in the response
  const balanced = extractBalancedJson(raw);
  if (balanced) {
    try {
      return validateAnalysis(JSON.parse(balanced), filePath);
    } catch { /* continue */ }
  }

  // Fallback: minimal analysis
  return createFallbackAnalysis(filePath);
}

function extractBalancedJson(text: string): string | null {
  let start = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function validateAnalysis(obj: unknown, filePath: string): LLMFileAnalysis {
  if (!obj || typeof obj !== 'object') {
    return createFallbackAnalysis(filePath);
  }

  const a = obj as Record<string, unknown>;

  // Deduplicate symbols by kind:name
  const rawSymbols: LLMSymbol[] = Array.isArray(a.symbols) ? a.symbols.map(validateSymbol) : [];
  const seen = new Set<string>();
  const symbols: LLMSymbol[] = [];
  for (const sym of rawSymbols) {
    const key = `${sym.kind}:${sym.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      symbols.push(sym);
    }
  }

  // Validate references
  const references = Array.isArray(a.references)
    ? a.references
        .filter((r: unknown): r is Record<string, unknown> =>
          !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).symbol_name === 'string')
        .map((r: Record<string, unknown>) => ({
          symbol_name: r.symbol_name as string,
          kind: (typeof r.kind === 'string' ? r.kind : 'other') as SymbolKind,
          line: typeof r.line === 'number' && r.line > 0 ? r.line : undefined,
          snippet: typeof r.snippet === 'string' && r.snippet.trim().length > 0
            ? r.snippet.trim().slice(0, 200)
            : undefined,
        }))
    : [];

  return {
    language: typeof a.language === 'string' ? normalizeLanguage(a.language, filePath) : guessLanguage(filePath),
    summary: typeof a.summary === 'string' ? a.summary : '',
    concepts: Array.isArray(a.concepts) ? a.concepts.filter((c): c is string => typeof c === 'string') : [],
    dependencies: Array.isArray(a.dependencies) ? a.dependencies.filter((d): d is string => typeof d === 'string') : [],
    internal_deps: Array.isArray(a.internal_deps) ? a.internal_deps.filter((d): d is string => typeof d === 'string') : [],
    external_deps: Array.isArray(a.external_deps) ? a.external_deps.filter((d): d is string => typeof d === 'string') : [],
    notes: Array.isArray(a.notes) ? a.notes.filter((n): n is string => typeof n === 'string') : [],
    complexity: typeof a.complexity === 'string' ? a.complexity : 'low',
    layer: typeof a.layer === 'string' ? a.layer : 'unknown',
    is_entry_point: typeof a.is_entry_point === 'boolean' ? a.is_entry_point : false,
    is_test: typeof a.is_test === 'boolean' ? a.is_test : false,
    is_generated: typeof a.is_generated === 'boolean' ? a.is_generated : false,
    symbols,
    references,
  };
}

function validateSymbol(sym: unknown): LLMSymbol {
  if (!sym || typeof sym !== 'object') {
    return { name: 'unknown', kind: 'other', signature: '', parent: null, extends_from: undefined, implements_list: undefined, modifiers: [], return_type: null, parameters: null, line: null, comment: null, tags: [] };
  }
  const s = sym as Record<string, unknown>;
  return {
    name: typeof s.name === 'string' ? s.name : 'unknown',
    kind: (typeof s.kind === 'string' ? s.kind : 'other') as SymbolKind,
    signature: typeof s.signature === 'string' ? s.signature : '',
    parent: typeof s.parent === 'string' ? s.parent : null,
    extends_from: typeof s.extends === 'string' ? s.extends : undefined,
    implements_list: Array.isArray(s.implements)
      ? s.implements.filter((i: unknown): i is string => typeof i === 'string')
      : undefined,
    modifiers: Array.isArray(s.modifiers) ? s.modifiers.filter((m): m is string => typeof m === 'string') : [],
    return_type: typeof s.return_type === 'string' ? s.return_type : null,
    parameters: typeof s.parameters === 'string' ? s.parameters : null,
    line: typeof s.line === 'number' ? s.line : null,
    comment: typeof s.comment === 'string' ? s.comment : null,
    tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

function createFallbackAnalysis(filePath: string): LLMFileAnalysis {
  return {
    language: guessLanguage(filePath),
    summary: `File: ${filePath}`,
    concepts: [],
    dependencies: [],
    internal_deps: [],
    external_deps: [],
    notes: ['Analysis could not be parsed'],
    complexity: 'low',
    layer: 'unknown',
    is_entry_point: false,
    is_test: false,
    is_generated: false,
    symbols: [],
    references: [],
  };
}

export function normalizeLanguage(llmLanguage: string, filePath: string): string {
  const map: Record<string, string> = {
    'typescript': 'TypeScript', 'javascript': 'JavaScript', 'python': 'Python',
    'ruby': 'Ruby', 'go': 'Go', 'rust': 'Rust', 'java': 'Java',
    'kotlin': 'Kotlin', 'swift': 'Swift', 'c#': 'C#', 'csharp': 'C#',
    'c++': 'C++', 'cpp': 'C++', 'c': 'C', 'php': 'PHP', 'sql': 'SQL',
    'shell': 'Shell', 'bash': 'Shell', 'json': 'JSON', 'yaml': 'YAML',
    'toml': 'TOML', 'xml': 'XML', 'html': 'HTML', 'css': 'CSS',
    'scss': 'SCSS', 'less': 'Less', 'markdown': 'Markdown', 'mdx': 'MDX',
    'vue': 'Vue', 'svelte': 'Svelte', 'dart': 'Dart', 'lua': 'Lua',
    'r': 'R', 'scala': 'Scala', 'zig': 'Zig', 'elixir': 'Elixir',
    'erlang': 'Erlang', 'haskell': 'Haskell', 'clojure': 'Clojure',
    'elm': 'Elm', 'terraform': 'Terraform', 'protobuf': 'Protobuf',
    'typescript/react': 'TypeScript', 'typescript config': 'TypeScript',
    'javascript/react': 'JavaScript', 'tsx': 'TypeScript', 'jsx': 'JavaScript',
  };
  const normalized = map[llmLanguage.toLowerCase()];
  if (normalized) return normalized;
  const guessed = guessLanguage(filePath);
  return guessed !== 'unknown' ? guessed : llmLanguage;
}

export function guessLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
    kt: 'Kotlin', swift: 'Swift', cs: 'C#', cpp: 'C++', c: 'C', h: 'C',
    php: 'PHP', sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
    html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
    md: 'Markdown', mdx: 'MDX', vue: 'Vue', svelte: 'Svelte',
    dart: 'Dart', lua: 'Lua', r: 'R', scala: 'Scala', zig: 'Zig',
    ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell',
    clj: 'Clojure', elm: 'Elm', tf: 'Terraform', proto: 'Protobuf',
  };
  return map[ext] ?? 'unknown';
}
