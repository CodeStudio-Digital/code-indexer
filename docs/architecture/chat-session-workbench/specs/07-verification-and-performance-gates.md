# 07 — Verificação, performance e gates

## 1. Princípio de evidência

Checkbox concluído exige evidência executável ou inspeção reproduzível. Relato,
review textual ou código existente sem execução não concluem gate.

## 2. Matriz de testes

### Contratos/backend

- schemas válidos e rejeição de payload inválido;
- paginação/cursor estável;
- busca/filtros/grupos;
- bootstrap pequeno e capabilities;
- revisions e ETag;
- batch com falha parcial;
- ownership filesystem e ausência de nova persistência SQLite;
- event query e export streaming;
- redação e limites de payload.

### Store/reconciliação

- isolamento por sessão;
- stale response;
- dedup por bus/seq;
- revision ordering;
- gap de replay;
- troca A → B → A;
- terminal duplicado;
- eviction e buffers bounded;
- selectors sem render cruzado.

### UI

- registry/capabilities;
- labels, badges e teclado;
- navigator virtualizado;
- estado visual preservado;
- lazy error/retry;
- overlay/sheet;
- plugin sandbox;
- PT-BR/EN.

### E2E

- projeto;
- global;
- editor compacto;
- App Studio Coder wrapper;
- sessão ativa durante troca de chat;
- reconnect/restart;
- Worker Log com backfill e live tail;
- snapshots;
- mobile e desktop estreito;
- ausência de `pageerror`.

## 3. Budgets

- **CSW-PERF-001** — Abrir sessão não dispara mais de uma leitura de bootstrap
  do workbench.
- **CSW-PERF-002** — Alternar entre destinos já carregados dispara zero fetch
  de bootstrap.
- **CSW-PERF-003** — Painel lazy cached deve apresentar chrome imediatamente e
  conteúdo em até 100 ms p95, excluindo rede fria documentada.
- **CSW-PERF-004** — Burst sustentado de 50 eventos/s não pode reduzir a
  interação abaixo de 55 FPS no hardware de baseline.
- **CSW-PERF-005** — Evento diagnóstico causa zero commit de
  `ConversationSurface`.
- **CSW-PERF-006** — Navigator com 10.000 sessões sintéticas mantém somente
  janela virtual bounded no DOM.
- **CSW-PERF-007** — Buffer live por sessão e total possuem caps medidos.
- **CSW-PERF-008** — Nenhum endpoint de painel materializa journal ilimitado.
- **CSW-PERF-009** — O bootstrap comprimido deve permanecer abaixo de 100 KB no
  fixture máximo; exceção exige ADR.
- **CSW-PERF-010** — Bundle inicial do chat não deve crescer; chunks de painel
  continuam lazy e possuem relatório before/after.

## 4. Gates

| Gate | Condição |
|---|---|
| G0 — Spec/baseline | Corpus aceito, baseline reproduzível, contratos desenhados |
| G1 — Backend read | Query service e endpoints com testes/limites |
| G2 — Events/commands | Protocolo canônico, replay e comandos provados |
| G3 — Store/controller | Reconciliation e selectors aprovados isoladamente |
| G4 — Shell/rails | Layout, registry, responsividade e a11y base aprovados |
| G5 — Panels | Todos os destinos funcionais sobre o contrato novo |
| G6 — Cutover | Todas as superfícies novas e legado removido |
| G7 — Release | E2E, visual, performance, build e runbook aprovados |

Nenhum gate pode ser aprovado com testes vermelhos classificados como “não
relacionados” sem registrar baseline, comando, erro e owner fora do programa.

## 5. Comandos mínimos de validação

Os comandos exatos devem ser atualizados conforme os testes forem criados:

```powershell
npx vitest run <suites-do-session-workbench>
npx playwright test --config apps/dashboard/playwright.config.ts <specs-do-workbench>
npm run build:dashboard
npm run typecheck
git diff --check
```

Testes amplos que falhem antes de atingir o cenário não substituem suíte focada.

## 6. Evidências aceitas

- output de teste com contagem;
- artifact de build;
- screenshot/golden aprovado;
- trace de React/Chrome;
- relatório de requests e bytes;
- benchmark com hardware e fixture;
- busca/grafo de imports;
- checklist de inspeção manual reproduzível;
- ADR aceito para exceção.

Cada evidência recebe ID no `IMPLEMENTATION-CHECKLIST.md` e é referenciada pela
etapa correspondente.

