// Reproduzir na raiz com pnpm exec tsx docs/research/clef-perfis-2026-11-24.ts.
import assert from 'node:assert/strict';
import { AGENTS } from '@mcp/code-agent/agents/index.js';
import { decide } from '@mcp/code-agent/agents/decision-engine.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';

const profiles = ['explore', 'plan', 'build', 'research', 'spec', 'unknown'] as const;
type Profile = (typeof profiles)[number];

// Quatro pedidos em português e dois em inglês por rótulo. Ordem e rótulos definidos antes da medição.
const cases: Record<Profile, string[]> = {
  explore: [
    'Quem preenche a lista de personagens quando abro esta cena?',
    'Me mostra o caminho de uma fatura desde a leitura do XML até a tela.',
    'Em que ponto desse repositório a sessão perde a referência ao projeto?',
    'Quero entender quem chama o método de sincronização do estoque.',
    'Track down the call site that sets the camera offset in this project.',
    'Walk me through the existing retry logic in our queue.',
  ],
  plan: [
    'Organiza em etapas a troca do armazenamento e aponta a ordem mais segura.',
    'Antes de codar, compare duas sequências de entrega da tela de cobrança.',
    'Desenhe a estratégia de migração das fotos, incluindo como voltar atrás.',
    'Como dividir em marcos a substituição do controlador de animações?',
    'Lay out a rollout sequence for switching our workers over to the new queue.',
    'Help me choose the order in which to tackle the billing migration.',
  ],
  build: [
    'Faça o botão de cancelar realmente parar a exportação em andamento.',
    'Arruma o salto de rotação do personagem e cobre o caso com um teste.',
    'Inclua o identificador do pedido no CSV que a aplicação gera.',
    'O leitor ignora a última linha vazia. Corrige o parser aqui.',
    'Patch the queue consumer so it releases the lock on cancellation.',
    'Add a regression test and fix the duplicate invoice entry.',
  ],
  research: [
    'Levante o que os fabricantes recomendam sobre retentativas de pagamento e cite as fontes.',
    'Encontre estudos publicados que comparem compressão de animações.',
    'Consulte a documentação do SQLite sobre concorrência e traga os links.',
    'Quero evidência externa sobre o impacto de quantização nos embeddings.',
    'Look up the vendor guidance on backoff and link to the original manuals.',
    'Find peer-reviewed comparisons of methods for motion interpolation.',
  ],
  spec: [
    'Formalize o que o sistema deve garantir ao cancelar uma tarefa, com exemplos de aceite.',
    'Escreva os requisitos funcionais da importação de clips, inclusive os casos de erro.',
    'Quero um contrato verificável de entrada e saída para a conciliação.',
    'Registre numa especificação quando uma sessão pode mudar de responsável.',
    'Draft a requirements document defining what counts as a successful refund.',
    'Write the acceptance criteria and edge cases for restoring a paused conversation.',
  ],
  unknown: [
    'Aquela questão de ontem.',
    'Depois eu te digo o que quero da agenda.',
    'Vi o arquivo novo aqui.',
    'Tenho algo sobre as animações, um minuto.',
    'About those invoices…',
    'Saving this thought for later.',
  ],
};
const noDecision = 'The task does not have enough information to select any option.';
const english = [
  'Trace or explain existing project code, data flow, callers and behavior.',
  'Compare implementation strategies and sequence milestones, dependencies and rollout.',
  'Change project files to implement a feature or fix a defect, and test the change.',
  'Look for external evidence in primary documentation, published studies and vendor guidance.',
  'Write requirements, contracts and acceptance criteria describing what the system must do.',
  noDecision,
];
const portuguese = [
  'Investigar o código existente e explicar o comportamento, o fluxo de dados e quem chama cada componente.',
  'Comparar estratégias de implementação, ordenar etapas, dependências e marcos da entrega.',
  'Alterar os arquivos do projeto para implementar uma funcionalidade ou corrigir um defeito, com testes.',
  'Buscar evidências externas em documentação oficial, estudos publicados e recomendações de fornecedores.',
  'Escrever requisitos, contratos e critérios de aceite que definem o comportamento esperado do sistema.',
  noDecision,
];
const catalogs = {
  runtime: profiles.map((id) => (id === 'unknown' ? noDecision : AGENTS[id].description)),
  deliverableEn: english,
  deliverablePt: portuguese,
};
const rows = profiles.flatMap((expected) => cases[expected].map((request) => ({ expected, request })));

function evaluate(predictions: string[]) {
  assert.equal(predictions.length, rows.length);
  const byClass = Object.fromEntries(profiles.map((label) => [label, 0]));
  let correct = 0;
  let shown = 0;
  let correctShown = 0;
  let ambiguousRouted = 0;
  for (const [i, predicted] of predictions.entries()) {
    const expected = rows[i].expected;
    if (predicted === expected) {
      correct++;
      byClass[expected]++;
    }
    if (predicted !== 'unknown') {
      shown++;
      if (predicted === expected) correctShown++;
      if (expected === 'unknown') ambiguousRouted++;
    }
  }
  return { correct, total: rows.length, shown, correctShown, ambiguousRouted, byClass };
}

const model = new LocalEmbeddingService();
try {
  const queries: number[][] = [];
  for (const row of rows) queries.push((await model.embedQuery(row.request)).vector);
  const metrics: Record<string, ReturnType<typeof evaluate>> = {
    localRules: evaluate(rows.map(({ request }) => decide(request).recommendedAgent)),
  };
  for (const [name, descriptions] of Object.entries(catalogs)) {
    const { vectors } = await model.embed(descriptions);
    // O Granite embarcado normaliza os vetores. O produto escalar equivale ao cosseno.
    const predictions = queries.map((query) => {
      const scores = vectors.map((candidate) =>
        candidate.reduce((sum, value, i) => sum + value * query[i], 0),
      );
      return profiles[scores.indexOf(Math.max(...scores))];
    });
    metrics[name] = evaluate(predictions);
  }
  const report = { model: model.fingerprint(), device: model.diagnostics().executionProvider, metrics };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await model.dispose();
}
