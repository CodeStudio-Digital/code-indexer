/**
 * correction-nudge — the regex trigger behind "the user corrected you →
 * offer remember()". Table-driven over PT-BR + EN phrasings, with the
 * negatives that matter: long specs containing "always", and neutral task
 * text, must NOT fire.
 */
import { describe, expect, it } from 'vitest';
import { detectCorrectionSignal, renderCorrectionHint } from '../correction-nudge.js';

describe('detectCorrectionSignal', () => {
  const preferences = [
    'nunca use emojis em mensagens de commit',
    'prefiro respostas curtas, sem tabelas',
    'a partir de agora, sempre rode o typecheck antes de terminar',
    'não use git stash neste projeto',
    'daqui pra frente crie arquivos com no máximo 200 linhas',
    'from now on, always run the linter before finishing',
    "don't ever use default exports here",
    'stop adding comments to every line',
    'I prefer conventional commits',
  ];
  for (const text of preferences) {
    it(`preference: "${text.slice(0, 40)}…"`, () => {
      expect(detectCorrectionSignal(text)).toBe('preference');
    });
  }

  const corrections = [
    'de novo isso? já te falei que o build roda com pnpm',
    'não era isso que eu pedi',
    'isso está errado, desfaça',
    'reverta essa mudança',
    'again? I already told you the tests need forks',
    "that's not what I asked for",
    'undo that last change',
  ];
  for (const text of corrections) {
    it(`correction: "${text.slice(0, 40)}…"`, () => {
      expect(detectCorrectionSignal(text)).toBe('correction');
    });
  }

  const negatives = [
    '', // empty
    'adiciona um botão de logout na navbar',
    'explica como funciona o pipeline de build',
    'can you refactor the auth module?',
    // A long spec containing "always" — the length guard must win.
    `spec: the service must always retry failed requests with exponential backoff. ${'x'.repeat(500)}`,
  ];
  for (const text of negatives) {
    it(`negative: "${text.slice(0, 40)}…"`, () => {
      expect(detectCorrectionSignal(text)).toBeNull();
    });
  }

  it('preference wins when both patterns appear (durable > episodic)', () => {
    expect(detectCorrectionSignal('de novo isso? nunca use emojis em commits')).toBe('preference');
  });
});

describe('renderCorrectionHint', () => {
  it('mentions remember with user scope and the skip clause', () => {
    for (const signal of ['preference', 'correction'] as const) {
      const hint = renderCorrectionHint(signal);
      expect(hint).toContain("remember({scope:'user'");
      expect(hint).toContain('Skip if it was one-off steering');
    }
  });
});
