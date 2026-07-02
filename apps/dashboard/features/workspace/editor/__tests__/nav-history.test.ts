/**
 * nav-history (pilhas back/forward da navegação de cursor) — módulo PURO,
 * testado direto em node: push/dedupe, back/forward, interleaving, cap e
 * reset por projeto.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetNavHistoryForTests,
  canNavBack,
  canNavForward,
  navBack,
  navForward,
  pushNavEntry,
  resetOnProject,
  type NavEntry,
} from '../nav-history.js';

const at = (line: number, path = 'src/a.ts', projectId = 1, column = 1): NavEntry => ({
  projectId,
  path,
  line,
  column,
});

beforeEach(() => {
  __resetNavHistoryForTests();
});

describe('pushNavEntry', () => {
  it('empilha e navBack retorna a última posição empilhada', () => {
    pushNavEntry(at(10));
    pushNavEntry(at(50));
    expect(canNavBack()).toBe(true);
    expect(navBack(at(200))).toEqual(at(50));
    expect(navBack(at(50))).toEqual(at(10));
    expect(navBack(at(10))).toBeNull(); // esvaziou
    expect(canNavBack()).toBe(false);
  });

  it('dedupa o topo quando ≈ mesma posição (±3 linhas), guardando a mais nova', () => {
    pushNavEntry(at(10, 'src/a.ts', 1, 2));
    pushNavEntry(at(12, 'src/a.ts', 1, 7)); // |12-10| ≤ 3 → funde
    expect(navBack(at(500))).toEqual(at(12, 'src/a.ts', 1, 7));
    expect(navBack(at(12))).toBeNull(); // só havia UMA entry
  });

  it('NÃO dedupa além de 3 linhas, arquivo diferente ou projeto diferente', () => {
    pushNavEntry(at(10));
    pushNavEntry(at(14)); // delta 4 → nova entry
    pushNavEntry(at(14, 'src/b.ts')); // outro arquivo
    pushNavEntry(at(14, 'src/b.ts', 2)); // outro projeto
    expect(navBack(at(999, 'x.ts'))).toEqual(at(14, 'src/b.ts', 2));
    expect(navBack(at(999, 'x.ts'))).toEqual(at(14, 'src/b.ts'));
    expect(navBack(at(999, 'x.ts'))).toEqual(at(14));
    expect(navBack(at(999, 'x.ts'))).toEqual(at(10));
  });

  it('limita a pilha a 100 entradas, dropando as mais antigas', () => {
    for (let i = 1; i <= 150; i++) pushNavEntry(at(i * 10)); // deltas > 3 → sem merge
    let hops = 0;
    let last: NavEntry | null = null;
    let cur: NavEntry = at(99_999, 'other.ts');
    for (;;) {
      const t = navBack(cur);
      if (!t) break;
      hops++;
      last = t;
      cur = t;
    }
    expect(hops).toBe(100);
    expect(last).toEqual(at(510)); // 150 pushes − 100 mantidas → mais antiga = #51
  });
});

describe('navBack / navForward', () => {
  it('back empilha a posição ATUAL no forward; forward devolve-a e re-empilha no back', () => {
    pushNavEntry(at(10));
    const current = at(300, 'src/b.ts');
    expect(navBack(current)).toEqual(at(10));
    expect(canNavForward()).toBe(true);

    // forward volta ao ponto de partida e re-empilha o "de onde vim" no back
    expect(navForward(at(10))).toEqual(current);
    expect(canNavForward()).toBe(false);
    expect(navBack(current)).toEqual(at(10)); // ciclo completo de novo
  });

  it('pula alvos ≈ posição atual (back que não moveria o cursor)', () => {
    pushNavEntry(at(10));
    pushNavEntry(at(100));
    // Atual ≈ topo (linha 101 vs 100) → pula direto para a entry anterior.
    expect(navBack(at(101))).toEqual(at(10));
    // A atual foi para o forward mesmo com o skip.
    expect(navForward(at(10))).toEqual(at(101));
  });

  it('retorna null (no-op) com pilhas vazias', () => {
    expect(navBack(at(5))).toBeNull();
    expect(navForward(at(5))).toBeNull();
  });

  it('navBack sem posição atual (editor fechado) ainda retorna o alvo', () => {
    pushNavEntry(at(10));
    expect(navBack(null)).toEqual(at(10));
    expect(canNavForward()).toBe(false); // nada para empilhar no forward
  });

  it('push novo limpa o forward (branch novo), interleaving completo', () => {
    pushNavEntry(at(10)); // deixa A:10
    pushNavEntry(at(100)); // deixa A:100
    // Em A:200 → back duas vezes.
    expect(navBack(at(200))).toEqual(at(100));
    expect(navBack(at(100))).toEqual(at(10));
    expect(canNavForward()).toBe(true);
    // Em A:10 o usuário salta para outro lugar → branch novo.
    pushNavEntry(at(10));
    expect(canNavForward()).toBe(false);
    expect(navForward(at(400))).toBeNull();
    // O back continua funcionando a partir do branch novo.
    expect(navBack(at(400))).toEqual(at(10));
  });

  it('forward NÃO limpa o forward restante (cadeia multi-hop)', () => {
    pushNavEntry(at(10));
    pushNavEntry(at(100));
    pushNavEntry(at(200));
    expect(navBack(at(300))).toEqual(at(200));
    expect(navBack(at(200))).toEqual(at(100));
    expect(navBack(at(100))).toEqual(at(10));
    // forward = [300, 200, 100] (topo = 100)
    expect(navForward(at(10))).toEqual(at(100));
    expect(navForward(at(100))).toEqual(at(200));
    expect(navForward(at(200))).toEqual(at(300));
    expect(canNavForward()).toBe(false);
  });
});

describe('resetOnProject', () => {
  it('descarta entries de outros projetos nas duas pilhas', () => {
    pushNavEntry(at(10, 'a.ts', 1));
    pushNavEntry(at(20, 'b.ts', 2));
    pushNavEntry(at(30, 'c.ts', 1));
    expect(navBack(at(900, 'z.ts', 1))).toEqual(at(30, 'c.ts', 1)); // forward ganha a atual (p1)
    resetOnProject(1);
    // Back perdeu a entry do projeto 2; sobrou só a do projeto 1.
    expect(navBack(at(30, 'c.ts', 1))).toEqual(at(10, 'a.ts', 1));
    expect(navBack(at(10, 'a.ts', 1))).toBeNull();
    // Forward manteve a entry (era do projeto 1).
    expect(canNavForward()).toBe(true);
  });
});
