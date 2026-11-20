/** Parse only direct commands, stdout/stderr logs and success-only chains.
 * This is evidence recognition, never shell execution or an approval policy. */
export function validationCommandParts(command: string): string[] | undefined {
  if (command.length > 16_384 || /[;|<`\r\n$#%^]/.test(command)) return undefined;
  const tokens: Array<{ value: string; operator?: boolean }> = [];
  let word = '', quote = '', hasWord = false;
  const flush = () => {
    if (hasWord) tokens.push({ value: word });
    word = ''; hasWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && command[i + 1] === quote) return undefined;
      if (c === quote) quote = '';
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; hasWord = true; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    if (!hasWord) {
      const redirect = /^(?:[12]>&[12]|[12]?>>?)/.exec(command.slice(i));
      if (redirect) {
        tokens.push({ value: redirect[0], operator: true });
        i += redirect[0].length - 1;
        continue;
      }
    }
    if (c === '&') {
      if (command[i + 1] !== '&') return undefined;
      flush(); tokens.push({ value: '&&', operator: true }); i++; continue;
    }
    if (c === '>') {
      flush();
      const op = command[i + 1] === '>' ? '>>' : '>';
      tokens.push({ value: op, operator: true }); i += op.length - 1; continue;
    }
    if (c === '(' || c === ')') return undefined;
    word += c; hasWord = true;
  }
  if (quote) return undefined;
  flush();
  const parts: string[] = [], words: string[] = [];
  const completePart = () => {
    // Quoted arguments stay single tokens: "pnpm test" is not an executable
    // named pnpm with a test argument. Preserve that distinction for evidence.
    if (!words.length || words.some(value => /\s/.test(value))) return false;
    parts.push(words.join(' ')); words.length = 0;
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.operator) { words.push(token.value); continue; }
    if (token.value === '&&') {
      if (!completePart()) return undefined;
    } else if (!token.value.includes('&')) {
      // A redirection needs exactly one filename, never another operator.
      const destination = tokens[++i];
      if (!destination || destination.operator || !destination.value) return undefined;
    }
  }
  if (!completePart()) return undefined;
  return parts.length <= 8 ? parts : undefined;
}

/** Normalize native command contracts for evidence only, without interpreting
 * argv tokens as shell syntax. Unknown/ambiguous contracts remain unclassified. */
export function validationInvocationParts(args: Record<string, unknown>): string[] | undefined {
  const inputs = [args.command, args.cmd, args.script].filter(value => value !== undefined);
  if (inputs.length !== 1) return undefined;
  const input = inputs[0];
  if (typeof input === 'string') return validationCommandParts(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const spec = input as Record<string, unknown>;
  if (spec.kind === 'shell' && typeof spec.script === 'string'
    && ['cmd', 'powershell', 'pwsh', 'sh', 'bash'].includes(String(spec.shell))) {
    return validationCommandParts(spec.script);
  }
  if (spec.kind !== 'argv' || typeof spec.executable !== 'string' || !Array.isArray(spec.args)) return undefined;
  const words = [spec.executable, ...spec.args];
  // Never collapse an argv item containing spaces/operators into executable
  // words (for example ["npm test"] or ["test", "&&", "write-file"]).
  if (words.length > 1025 || words.some(word => typeof word !== 'string' || !word
    || /[\s;&|<>`$#%^()\0]/.test(word))) return undefined;
  const command = words.join(' ');
  return command.length <= 16_384 ? [command] : undefined;
}

const DIFF_INSPECTION_FLAGS = new Set([
  '--check', '--stat', '--numstat', '--shortstat', '--name-only', '--name-status',
  '--cached', '--staged', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
]);
const STATUS_INSPECTION_FLAGS = new Set([
  '--short', '-s', '-sb', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2',
  '-uno', '--untracked-files=no',
]);

/** Narrow inspection recognition for freshness accounting, NOT authorization,
 * retries or parallel dispatch. No test success is inferred from an inspection. */
export function isVerificationObservation(name: string, args: Record<string, unknown>): boolean {
  // Running a checker observes the code; it is never an edit, whatever it reports.
  if (name === 'get_diagnostics') return true;
  if (!['exec_command', 'run_command', 'shell_command'].includes(name)) return false;
  // Log redirects can overwrite code, even when the underlying command reads.
  const command = args.command ?? args.cmd ?? args.script;
  if (typeof command === 'string' && /[<>]/.test(command)) return false;
  if (command && typeof command === 'object' && !Array.isArray(command)) {
    const spec = command as Record<string, unknown>;
    if (spec.kind === 'shell' && typeof spec.script === 'string' && /[<>]/.test(spec.script)) return false;
    // A common Windows inspection uses a structured PowerShell invocation.
    // Accept only literal Get-Content statements, never an arbitrary script.
    if (args.cmd === undefined && args.script === undefined && spec.kind === 'argv'
      && typeof spec.executable === 'string' && /^(?:powershell|pwsh)(?:\.exe)?$/i.test(spec.executable)
      && Array.isArray(spec.args) && spec.args.length === 3
      && String(spec.args[0]).toLowerCase() === '-noprofile' && String(spec.args[1]).toLowerCase() === '-command'
      && typeof spec.args[2] === 'string' && spec.args[2].length <= 16_384) {
      const statements = spec.args[2].split(';');
      return statements.length <= 8 && statements.every(statement =>
        /^Get-Content +[\w.\\/-]+(?: +-Tail +\d{1,6})? *$/i.test(statement.trim()));
    }
  }
  const parts = validationInvocationParts(args);
  return !!parts?.every(part => {
    if (/^(?:node|git)(?:\.exe)? --version$/.test(part)) return true;
    const words = part.split(' ');
    if (!/^git(?:\.exe)?$/.test(words.shift() ?? '')) return false;
    const operation = words.shift();
    const flags = operation === 'diff' ? DIFF_INSPECTION_FLAGS : operation === 'status' ? STATUS_INSPECTION_FLAGS : undefined;
    if (!flags) return false;
    let paths = false;
    return words.every(word => {
      if (!paths && word === '--') { paths = true; return true; }
      return paths ? /^[\w.\\/-]+$/.test(word) : flags.has(word);
    });
  });
}

/** Known local CLI entrypoints; arbitrary Node/Python programs are not checks. */
export function unwrapValidationExecutable(command: string): string {
  const normalized = command.replaceAll('\\', '/').toLowerCase().trim();
  const directBin = /^(?:\.\/)?node_modules\/\.bin\/(tsc|vitest|jest|eslint|xo|ava)(?:\.cmd)?(?=\s|$)/;
  if (directBin.test(normalized)) return normalized.replace(directBin, '$1');
  return normalized
    .replace(/^node(?:\.exe)?\s+(?:\.\/)?node_modules\/typescript\/bin\/tsc(?=\s|$)/, 'tsc')
    .replace(/^node(?:\.exe)?\s+(?:\.\/)?node_modules\/ava\/entrypoints\/cli\.mjs(?=\s|$)/, 'ava')
    .replace(/^node(?:\.exe)?\s+(?:\.\/)?node_modules\/vitest\/vitest\.mjs(?=\s|$)/, 'vitest')
    .replace(/^node(?:\.exe)?\s+(?:\.\/)?node_modules\/eslint\/bin\/eslint\.js(?=\s|$)/, 'eslint');
}
