import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifiesDisconnectedConfiguration as check } from '../../evals/agent-effectiveness/disconnected-config.mjs';

test('accepts unused configuration claims across Portuguese gender and copula variants', () => {
  for (const text of ['configuração não utilizada', 'valor não é consumido por ninguém',
    'valores não são usados', 'opções não estão conectadas', '**não é consumido**',
    'declaração duplicada', 'an unused declaration', 'configuração não consumida']) assert.equal(check(text), true, text);
});
test('does not accept effective settings or unrelated negatives as disconnected declarations', () => {
  for (const text of ['configuração utilizada pelo token', 'o valor é consumido',
    'não existe outro consumidor', 'não altera arquivos', 'TTL vem de SESSION_TTL_MS',
    'não é consumidora de dados']) assert.equal(check(text), false, text);
});
