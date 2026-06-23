/**
 * W1b — namespacing de URI do modelo Monaco. Testa os helpers puros (sem Monaco).
 * Em node não há localStorage → nsModelUrisEnabled()=true (NS ON), o modo de produção.
 * A garantia crítica: parseModelPath sempre devolve o relpath LIMPO (o que vai ao backend LSP).
 */
import { describe, it, expect } from 'vitest';
import { modelPathFor, parseModelPath, nsModelUrisEnabled } from '../editor-models-path.js';

describe('editor-models-path (W1b)', () => {
  it('NS habilitado por padrão (sem localStorage em node)', () => {
    expect(nsModelUrisEnabled()).toBe(true);
  });

  it('modelPathFor prefixa por projectId', () => {
    expect(modelPathFor(42, 'src/index.ts')).toBe('p42/src/index.ts');
  });

  it('parseModelPath extrai o relpath limpo (com e sem leading slash)', () => {
    expect(parseModelPath('/p42/src/index.ts')).toEqual({ projectId: 42, relPath: 'src/index.ts' });
    expect(parseModelPath('p42/src/index.ts')).toEqual({ projectId: 42, relPath: 'src/index.ts' });
  });

  it('round-trip modelPathFor → parseModelPath preserva o relpath (feed do LSP intacto)', () => {
    const rel = 'a/b/c.php';
    expect(parseModelPath('/' + modelPathFor(7, rel))).toEqual({ projectId: 7, relPath: rel });
  });

  it('arquivo cujo path começa com p<dígitos>/ não é mal-atribuído (strip de UM prefixo)', () => {
    // modelPathFor(5, 'p2/foo.ts') = 'p5/p2/foo.ts' → strip só do nosso prefixo p5/
    expect(parseModelPath('/p5/p2/foo.ts')).toEqual({ projectId: 5, relPath: 'p2/foo.ts' });
  });

  it('modelo não namespaced (merge inmemory / dir "pages") → projectId null, relpath intacto', () => {
    expect(parseModelPath('/merge-ours/src/x.ts')).toEqual({ projectId: null, relPath: 'merge-ours/src/x.ts' });
    expect(parseModelPath('/pages/foo.ts')).toEqual({ projectId: null, relPath: 'pages/foo.ts' });
  });
});
