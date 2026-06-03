/**
 * Stack profiles — the configuration that makes the training pipeline
 * multi-language. Adding a language/stack means adding one object here, NOT
 * touching the engine (seed-extractor, teacher, validator all read the profile).
 *
 * A profile defines four things:
 *   - `extensions` + `importMarkers`: which project symbols/files seed it.
 *   - `defaultDocCollection`: which RAG corpus grounds the teacher (overridable).
 *   - `promptFraming`: how the teacher is told to produce examples.
 *   - `validatorCmds` (+ optional `sandboxTemplate`/`outputPath`): the gate that
 *     decides if a generated `output` joins the dataset.
 */

export interface ValidatorCmd {
  label: string;
  /** Shell command run (via IShellPort.exec) inside the sandbox/project dir. */
  cmd: string;
  /** Non-zero exit fails the example. Default true. */
  required?: boolean;
}

export interface StackProfile {
  id: string;
  label: string;
  /** File extensions whose symbols are candidate seeds. */
  extensions: string[];
  /** Import substrings (any-match) that confirm the stack. Empty = no filter. */
  importMarkers: string[];
  /** Default RAG collection name; the wizard can override per-dataset. */
  defaultDocCollection?: string;
  /** Validator commands, run in order. */
  validatorCmds: ValidatorCmd[];
  /** Kind of provisioned sandbox the validator runs in (data dir). When unset,
   *  the validator uses a throwaway OS temp dir. */
  sandbox?: 'shadcn-vite';
  /** Where in the sandbox the generated `output` is written. */
  outputPath?: string;
  /** System framing handed to the teacher provider. */
  promptFraming: string;
  /** Whether the optional Vite render + screenshot visual gate applies. */
  visualGateCapable?: boolean;
}

const TS_VALIDATORS: ValidatorCmd[] = [
  { label: 'typecheck', cmd: 'npx --no-install tsc --noEmit' },
  { label: 'lint', cmd: 'npx --no-install eslint . --max-warnings 0', required: false },
];

export const STACK_PROFILES: Record<string, StackProfile> = {
  'react-shadcn-vite': {
    id: 'react-shadcn-vite',
    label: 'React + shadcn/ui (Vite)',
    extensions: ['.tsx'],
    importMarkers: ['react', '@/components/ui'],
    defaultDocCollection: 'shadcn-docs',
    sandbox: 'shadcn-vite',
    outputPath: 'src/__candidate__.tsx',
    validatorCmds: [
      { label: 'typecheck', cmd: 'npx --no-install tsc --noEmit' },
      { label: 'lint', cmd: 'npx --no-install eslint src --max-warnings 0', required: false },
      { label: 'build', cmd: 'npx --no-install vite build', required: false },
    ],
    visualGateCapable: true,
    promptFraming:
      'You write idiomatic React + TypeScript dashboard UI using shadcn/ui ' +
      'components and Tailwind. Compose existing shadcn primitives ' +
      '(Card, Button, Table, …) — never invent components. Default exports a ' +
      'single self-contained component.',
  },
  react: {
    id: 'react',
    label: 'React + TypeScript',
    extensions: ['.tsx', '.ts'],
    importMarkers: ['react'],
    validatorCmds: TS_VALIDATORS,
    promptFraming:
      'You write idiomatic React + TypeScript components with hooks. Output a ' +
      'single self-contained, type-correct component.',
  },
  angular: {
    id: 'angular',
    label: 'Angular',
    extensions: ['.ts'],
    importMarkers: ['@angular/'],
    validatorCmds: TS_VALIDATORS,
    promptFraming:
      'You write idiomatic Angular components/services using decorators and ' +
      'dependency injection. Output type-correct TypeScript.',
  },
  vue: {
    id: 'vue',
    label: 'Vue 3',
    extensions: ['.vue', '.ts'],
    importMarkers: ['vue'],
    validatorCmds: [{ label: 'typecheck', cmd: 'npx --no-install vue-tsc --noEmit' }],
    promptFraming:
      'You write idiomatic Vue 3 single-file components using the Composition ' +
      'API and <script setup lang="ts">.',
  },
  'node-ts': {
    id: 'node-ts',
    label: 'Node.js + TypeScript',
    extensions: ['.ts'],
    importMarkers: [],
    validatorCmds: TS_VALIDATORS,
    promptFraming:
      'You write idiomatic, type-correct Node.js + TypeScript modules with ' +
      'clear single-responsibility functions.',
  },
  python: {
    id: 'python',
    label: 'Python',
    extensions: ['.py'],
    importMarkers: [],
    validatorCmds: [
      { label: 'lint', cmd: 'ruff check .', required: false },
      { label: 'typecheck', cmd: 'mypy .', required: false },
      { label: 'test', cmd: 'pytest -q', required: false },
    ],
    promptFraming:
      'You write idiomatic, type-annotated Python following PEP 8. Output a ' +
      'single self-contained module.',
  },
  go: {
    id: 'go',
    label: 'Go',
    extensions: ['.go'],
    importMarkers: [],
    validatorCmds: [
      { label: 'vet', cmd: 'go vet ./...' },
      { label: 'test', cmd: 'go test ./...', required: false },
    ],
    promptFraming:
      'You write idiomatic Go with clear error handling and standard project ' +
      'layout. Output a single self-contained package file.',
  },
};

export function getProfile(id: string): StackProfile {
  const p = STACK_PROFILES[id];
  if (!p) {
    throw new Error(
      `Unknown stack profile '${id}'. Known: ${Object.keys(STACK_PROFILES).join(', ')}.`,
    );
  }
  return p;
}

export function listProfiles(): StackProfile[] {
  return Object.values(STACK_PROFILES);
}
