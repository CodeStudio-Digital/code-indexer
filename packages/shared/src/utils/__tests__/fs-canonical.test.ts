/**
 * W3 — canonicalizador único de path. A garantia: didOpen e completion derivam a MESMA
 * chave (forward-slash + drive lowercase), senão o intelephense não reconhece o arquivo.
 */
import { describe, it, expect } from 'vitest';
import { canonicalAbs, relToAbsCanonical, absToRelCanonical } from '../fs-canonical.js';

describe('fs-canonical', () => {
  it('lowercase drive + forward slash + sem trailing slash', () => {
    expect(canonicalAbs('D:\\proj\\X.php')).toBe('d:/proj/X.php');
    expect(canonicalAbs('D:/proj/')).toBe('d:/proj');
    expect(canonicalAbs('/usr/x.ts')).toBe('/usr/x.ts');
    expect(canonicalAbs('D:/')).toBe('d:/'); // raiz de drive preservada
  });

  it('relToAbs canônico (== chave do didOpen e da completion)', () => {
    expect(relToAbsCanonical('D:\\proj', 'domain/service/X.php')).toBe('d:/proj/domain/service/X.php');
    expect(relToAbsCanonical('D:/proj/', 'a\\b.php')).toBe('d:/proj/a/b.php');
  });

  it('absToRel round-trip + rejeita fora da raiz', () => {
    const root = 'D:\\proj';
    const rel = 'a/b/c.php';
    expect(absToRelCanonical(root, relToAbsCanonical(root, rel))).toBe(rel);
    expect(absToRelCanonical('D:/proj', 'd:/other/x.php')).toBeNull();
  });
});
