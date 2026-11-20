/** Match instructions about remembered project/user facts in the current user turn. */
export function suppressesMemoryRecall(message?: string | null): boolean {
  const text = (message ?? '').replace(/\b(?:uso|consumo|vazamento|limite)\s+(?:de|da)\s+mem[oó]ria\b/gi, 'RAM');
  return /\b(?:ignore|ignorar|desconsidere|disregard|skip|don['’]?t use|do not use|n[aã]o use|n[aã]o usar|n[aã]o utilize)\b[\s\S]{0,20}mem[oó]r(?:y|ia)\b(?!\s*(?:leaks?|usage|checks?|profiles?|profiler|pressure|footprint|heap|ram|cache))/i.test(text);
}
