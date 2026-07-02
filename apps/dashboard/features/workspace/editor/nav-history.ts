/**
 * Histórico global de navegação do cursor (IntelliJ Ctrl+Alt+Left/Right).
 *
 * Duas pilhas (back/forward) de posições `{projectId, path, line, column}`.
 * PURO de propósito — sem imports de Monaco nem do workspace store — para
 * ser testável em vitest node. O glue (push points, goto, comandos) vive em
 * `nav-commands.ts`.
 *
 * Semântica:
 *  - `pushNavEntry` registra a posição que está sendo DEIXADA (salto grande
 *    de cursor, troca de aba, goto do LSP). Se o topo é ≈ a mesma posição
 *    (mesmo arquivo, ±3 linhas) ele é FUNDIDO (refresh com a posição mais
 *    nova) em vez de empilhado. Toda entrada nova inicia um branch novo de
 *    navegação → limpa a pilha forward.
 *  - `navBack(current)` empilha `current` no forward, desempilha do back e
 *    retorna o alvo — pulando alvos ≈ `current`, que seriam no-ops visuais.
 *  - `navForward(current)` é o inverso (empilha no back, NÃO limpa forward).
 *  - Ambas as pilhas são limitadas a 100 entradas (dropa as mais antigas).
 */

export interface NavEntry {
  projectId: number;
  /** Path relativo ao projeto (mesma forma que o workspace store usa). */
  path: string;
  /** 1-based, como o Monaco. */
  line: number;
  column: number;
}

const MAX_STACK = 100;
const NEAR_LINES = 3;

let back: NavEntry[] = [];
let forward: NavEntry[] = [];

/** Mesmo arquivo e a até NEAR_LINES linhas de distância. */
function near(a: NavEntry, b: NavEntry): boolean {
  return (
    a.projectId === b.projectId &&
    a.path === b.path &&
    Math.abs(a.line - b.line) <= NEAR_LINES
  );
}

/** Push com merge-de-topo (dedupe ±3 linhas) + cap. */
function pushOnto(stack: NavEntry[], entry: NavEntry): void {
  const top = stack[stack.length - 1];
  if (top && near(top, entry)) {
    stack[stack.length - 1] = entry; // refresh — mantém a posição mais fresca
    return;
  }
  stack.push(entry);
  if (stack.length > MAX_STACK) stack.splice(0, stack.length - MAX_STACK);
}

/** Registra a posição sendo deixada. Inicia branch novo (limpa forward). */
export function pushNavEntry(entry: NavEntry): void {
  pushOnto(back, entry);
  if (forward.length > 0) forward = [];
}

/**
 * Volta: retorna a entry alvo (ou null sem histórico — caller faz no-op).
 * `current` (posição atual do editor) vai para a pilha forward para que
 * navForward retorne. Alvos ≈ current são descartados (evita "back" que
 * não move o cursor quando o topo é a própria posição atual).
 */
export function navBack(current: NavEntry | null): NavEntry | null {
  while (back.length > 0) {
    const target = back.pop() as NavEntry;
    if (current && near(target, current)) continue;
    if (current) pushOnto(forward, current);
    return target;
  }
  return null;
}

/** Avança: inverso de navBack (empilha `current` no back, não limpa forward). */
export function navForward(current: NavEntry | null): NavEntry | null {
  while (forward.length > 0) {
    const target = forward.pop() as NavEntry;
    if (current && near(target, current)) continue;
    if (current) pushOnto(back, current);
    return target;
  }
  return null;
}

export function canNavBack(): boolean {
  return back.length > 0;
}

export function canNavForward(): boolean {
  return forward.length > 0;
}

/**
 * Troca de projeto: entries de outros projetos apontariam para abas que o
 * setProject acabou de dropar (e openFile com projectId antigo contaminaria
 * o pool). Mantém só as do projeto que entra.
 */
export function resetOnProject(projectId: number): void {
  back = back.filter((e) => e.projectId === projectId);
  forward = forward.filter((e) => e.projectId === projectId);
}

/** Test hook — zera as duas pilhas (estado é module-level). */
export function __resetNavHistoryForTests(): void {
  back = [];
  forward = [];
}
