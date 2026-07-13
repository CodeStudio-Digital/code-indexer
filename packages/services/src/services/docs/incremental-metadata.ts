import { createHash } from 'node:crypto';
import { extractApiSignature, type ApiSignature } from './api-signature.js';

export function stableChunkKey(input: {
  itemKey: string;
  pageKey: string;
  headingPath: string;
  occurrence: number;
}): string {
  return createHash('sha1')
    .update(`${input.itemKey}\0${input.pageKey}\0${input.headingPath}\0${input.occurrence}`)
    .digest('hex');
}

export function extractApiMetadata(headingPath: string | null, content: string): ApiSignature {
  const heading = extractApiSignature(headingPath);
  const declaration = /(?:^|\n)\s*(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|extern|async)\s+)+(?:[\w<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*(\([^;\n]{0,500}\))/m.exec(content);
  if (!declaration) return heading;
  const owner = heading.symbol?.includes('.') ? heading.symbol.split('.').slice(0, -1).join('.') : null;
  const symbol = owner ? `${owner}.${declaration[1]}` : (heading.symbol ?? declaration[1]!);
  return { symbol, signature: `${symbol}${declaration[2]}`.replace(/\s+/g, ' ') };
}

export function deterministicMetadata(
  headingPath: string,
  content: string,
  api: ApiSignature,
): { summary: string | null; concepts: string[]; strong: boolean } {
  const paragraphs = content
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 50 && !/^(declaration|parameters?|returns?|description)$/i.test(p));
  const summary = paragraphs[0]?.slice(0, 420) ?? null;
  const concepts = new Set<string>();
  for (const part of headingPath.split(/\s*>\s*|[.#]/)) {
    const t = part.trim();
    if (t.length >= 3 && t.length <= 80) concepts.add(t);
  }
  if (api.symbol) concepts.add(api.symbol);
  if (api.signature) concepts.add(api.signature.slice(0, 80));
  const identifiers = content.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? [];
  for (const id of identifiers.slice(0, 12)) concepts.add(id);
  const list = [...concepts].slice(0, 8);
  return { summary, concepts: list, strong: !!summary && summary.length >= 100 && list.length >= 3 };
}
