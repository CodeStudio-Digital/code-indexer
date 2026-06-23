/**
 * Diff linha-a-linha auto-contido (LCS) — sem dependências. Usado pelo painel
 * de Local History para mostrar o que mudou entre uma revisão e o disco atual.
 * Para arquivos muito grandes cai num diff grosso (tudo removido + tudo
 * adicionado) para não estourar a tabela O(n·m).
 */
export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

const MAX_CELLS = 4_000_000; // ~2000×2000 linhas

/**
 * Normaliza para comparação de linhas: remove BOM inicial e unifica CRLF/CR → LF.
 * Sem isso, snapshot CRLF vs. disco LF (comum no Windows) faz toda linha divergir
 * pelo `\r` final → diff acusa o arquivo inteiro como alterado. Espelha o
 * `hashContent` do file-local-history-store (que já normaliza CRLF/CR → LF).
 */
export const normalizeForDiff = (s: string): string => {
  const body = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; // tira BOM inicial
  return body.replace(/\r\n?/g, '\n'); // CRLF e CR solto → LF
};

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = normalizeForDiff(oldText).split('\n');
  const b = normalizeForDiff(newText).split('\n');
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }

  // LCS por programação dinâmica (sufixos).
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** Resumo {+adições, −remoções} para o cabeçalho. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}
