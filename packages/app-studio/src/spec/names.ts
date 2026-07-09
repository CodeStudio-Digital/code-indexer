/**
 * Coerção de nomes de código da AppSpec — compartilhada entre o
 * normalizador (`normalize.ts`, que coage o que o MODELO manda) e o modo
 * Blueprint (que deriva ids/nomes de nós criados pelo USUÁRIO na palette).
 * Uma única fonte garante que "Meu Pedido" vira `meu-pedido`/`meu_pedido`
 * igual nos dois caminhos.
 */

/** Remove acentos (á→a, ç→c) para ids/nomes de código ASCII-safe. */
export function deburr(s: string): string {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** camelCase/PascalCase/espaços/acentos → kebab-case. */
export function kebab(s: string): string {
  return deburr(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** camelCase/espaços/acentos → snake_case. */
export function snake(s: string): string {
  return deburr(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** snake_name → "Snake name" (label humano default). */
export function titleize(name: string): string {
  const s = snake(name).replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name;
}

/** "Painel de pedidos" → "PainelDePedidosScreen" (nome de componente). */
export function pascalScreenName(label: string): string {
  const base = deburr(label)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  const pascal = base || 'Screen';
  return pascal.endsWith('Screen') ? pascal : `${pascal}Screen`;
}
