/**
 * Parsers leves de código-fonte compartilhados pelo package-audit e pelo
 * studio-audit: extração de blocos balanceados/objetos (string-literal
 * aware, sem AST), nomes exportados, entradas do registry de demos e
 * remoção de comentários. Nada aqui usa fs — texto puro entra, dados saem.
 */

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bloco `{...}` balanceado a partir de `startBrace`, respeitando strings. */
export function extractBalanced(text: string, startBrace: number): string | null {
  if (text[startBrace] !== '{') return null;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = startBrace; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startBrace, i + 1);
    }
  }
  return null;
}

/** Todos os blocos `{...}` que seguem `propertyName:` no texto. */
export function extractNamedObjectBlocks(text: string, propertyName: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const brace = text.indexOf('{', re.lastIndex);
    if (brace < 0) continue;
    const block = extractBalanced(text, brace);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** Bloco `{...}` da propriedade nomeada dentro de um object literal. */
export function extractPropertyObject(objectBlock: string, propertyName: string): string | null {
  const re = new RegExp(`(?:^|[,{])\\s*${escapeRegExp(propertyName)}\\s*:`, 'm');
  const match = re.exec(objectBlock);
  if (!match) return null;
  const brace = objectBlock.indexOf('{', match.index);
  if (brace < 0) return null;
  return extractBalanced(objectBlock, brace);
}

/** Chaves de primeiro nível de um object literal `{a: …, b: …}`. */
export function topLevelObjectKeys(objectBlock: string): string[] {
  const body = objectBlock.replace(/^\{|\}$/g, '');
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (depth === 0 && /[A-Za-z0-9_$]/.test(ch)) {
      token += ch;
      continue;
    }
    if (depth === 0 && ch === ':' && token) {
      keys.push(token);
      token = '';
      continue;
    }
    if (depth === 0 && ch === ',') token = '';
    if (depth === 0 && !/\s/.test(ch)) token = '';
  }
  return Array.from(new Set(keys));
}

/**
 * Entradas do registry de demos (`export const demos … = { Button: …, … }`):
 * chave → bloco de valor (para o variant-coverage inspecionar o demo).
 */
export function extractDemoEntries(registrySource: string): Map<string, string> {
  const entries = new Map<string, string>();
  const match = /\bdemos\b[^=]*=\s*\{/.exec(registrySource);
  if (!match) return entries;
  const block = extractBalanced(registrySource, registrySource.indexOf('{', match.index));
  if (!block) return entries;
  for (const key of topLevelObjectKeys(block)) {
    const valueBlock = extractPropertyObject(block, key);
    entries.set(key, valueBlock ?? blockSlice(block, key));
  }
  return entries;
}

/** Fallback: trecho do bloco a partir da chave (valores não-objeto, ex. JSX). */
function blockSlice(block: string, key: string): string {
  const re = new RegExp(`\\b${escapeRegExp(key)}\\s*:`);
  const m = re.exec(block);
  if (!m) return '';
  return block.slice(m.index, m.index + 2000);
}

/** Nomes exportados via `export { A, B as C }` e `export const/function X`. */
export function extractExportedNames(source: string): { names: string[]; hasWildcard: boolean } {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const token = part.trim();
      if (!token || token.startsWith('type ')) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(token);
      names.add(asMatch ? asMatch[1] : token.split(/\s+/)[0]);
    }
  }
  for (const m of source.matchAll(/export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  return { names: [...names], hasWildcard: /export\s*\*\s*from/.test(source) };
}

/** Remove comentários // e /* *​/ preservando strings (para scans de literal). */
export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
