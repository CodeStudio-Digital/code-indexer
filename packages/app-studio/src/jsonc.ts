/**
 * Parse leve de JSONC (wrangler.jsonc) — strip de comentários // e em bloco
 * FORA de strings + vírgula final tolerada. Suficiente porque o template do
 * wrangler.jsonc é NOSSO (determinístico); não é um parser JSONC geral.
 */
export function stripJsoncComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

export function parseJsonc<T = unknown>(text: string): T | null {
  try {
    const stripped = stripJsoncComments(text).replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped) as T;
  } catch {
    return null;
  }
}
