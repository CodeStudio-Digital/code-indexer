# Atlas ClaudeOpen → CodeStudio

> Status: atlas, roadmap e implementação incremental. Os documentos `18` e
> `19` registram, respectivamente, o plano da Fase 3 e as correções de runtime
> já incorporadas. O baseline comparativo dos documentos `00`–`17` permanece
> histórico e auditável.

## Objetivo

Este corpus compara, mecanismo por mecanismo, o snapshot local do ClaudeOpen com o CodeStudio 3.15.1. A meta não é copiar uma implementação desminificada, mas identificar contratos eficazes, preservar vantagens internas e ordenar uma convergência verificável.

As perguntas centrais são:

1. Como ClaudeOpen compõe tools, MCP, permissões, prompts, hooks e eventos?
2. Como lança, isola, acompanha, retoma e verifica agentes/subagentes?
3. O que `ultracode` realmente significa e por que não deve ser tratado como um modelo separado?
4. Como memória, transcript, contexto e compactação se complementam?
5. Onde o CodeStudio já é mais forte?
6. Quais lacunas do CodeStudio são comprovadas, quais são apenas riscos e quais são percepções de UX?
7. Que contratos e gates permitem convergir sem uma reescrita de alto risco?

## Baseline

| Fonte | Baseline auditado | Evidência |
|---|---|---|
| Claude Code CLI | 2.1.215; bundle desminificado e reorganizado em 4.764 módulos | `claudeopen/claude-code-src/README.md:1-18` |
| Claude Desktop | snapshot de `app.asar` reorganizado em 108 arquivos; versão do aplicativo não declarada no corpus | `claudeopen/asar-src/README.md:1-27` |
| CodeStudio | 3.15.1 | `codestudio_mcp-codebase/package.json:1-18` |
| Código interno | commit observado no início da execução: `61e5769cbe2ac2530a32ae547576d5d70f7bc693` | `git log -1 --format=%H` |

O snapshot Desktop não deve ser automaticamente identificado com as notas antigas de Claude Desktop 1.8089.1. O limite está detalhado em [00-scope-provenance-method.md](./00-scope-provenance-method.md).

## Decisões vinculantes do baseline

- A entrega original dos documentos `00`–`17` foi **atlas + roadmap**, sem
  mudanças funcionais; as fases de implementação posteriores são registradas
  separadamente para não reescrever a evidência histórica.
- Estratégia: **híbrida por contratos**; preservar as vantagens do CodeStudio.
- Eventos: **journal canônico lossless + projeções**; o log diagnóstico atual não é o event source.
- Ultra: **preset ortogonal** de effort, orquestração, paralelismo, verificação, durabilidade e isolamento.
- Tiers: **visibilidade/context budget, não segurança**; Policy Engine decide autorização.

Motivações, alternativas e gatilhos de revisão estão em [DECISIONS.md](./DECISIONS.md).

## Como ler

### Leitura executiva

1. [00 — Escopo, proveniência e método](./00-scope-provenance-method.md)
2. [12 — Matriz de capacidades](./12-capability-parity-matrix.md)
3. [14 — Control plane e contratos-alvo](./14-target-control-plane-contracts.md)
4. [15 — Roadmap, fases e gates](./15-roadmap-phases-gates.md)
5. [16 — Plano de avaliação](./16-evaluation-benchmark-plan.md)
6. [17 — Riscos e questões abertas](./17-risk-register-open-questions.md)
7. [18 — Plano da Fase 3](./18-fase-3-plan.md)
8. [19 — Correções de maturidade do runtime](./19-runtime-hardening-corrections.md)

### Leitura ClaudeOpen

1. [01 — Topologia de runtime](./01-claudeopen-runtime-topology.md)
2. [02 — Tools, MCP e permissões](./02-claudeopen-tools-mcp-permissions.md)
3. [03 — Loop, prompts, hooks e streaming](./03-claudeopen-agent-loop-prompts-hooks-streaming.md)
4. [04 — Subagentes, teams e workflows](./04-claudeopen-subagents-teams-workflows.md)
5. [05 — Ultracode, effort e thinking](./05-claudeopen-ultracode-effort-thinking.md)
6. [06 — Memória, contexto e compactação](./06-claudeopen-memory-context-compaction.md)

### Leitura CodeStudio

1. [07 — Runner e orquestração](./07-codestudio-runner-orchestration.md)
2. [08 — Tools, MCP, tiers e policy](./08-codestudio-tools-mcp-tiers-policy.md)
3. [09 — Subagentes, workflows, isolamento e Ultra](./09-codestudio-subagents-workflows-isolation-ultra.md)
4. [10 — Sessão, streaming e dashboard](./10-codestudio-session-streaming-dashboard.md)
5. [11 — Memória, prompts e hooks](./11-codestudio-memory-prompts-hooks.md)

### Leitura por fluxo

- [13 — Traces ponta a ponta](./13-end-to-end-traces.md)
- [EVIDENCE_INDEX — Índice auditável de evidências](./EVIDENCE_INDEX.md)

## Mapa completo

| Documento | Finalidade |
|---|---|
| `README.md` | Índice, baseline e ordem de leitura |
| `00-scope-provenance-method.md` | Método, taxonomia de evidência e limites |
| `01-claudeopen-runtime-topology.md` | Processos, workers, IPC, fronteiras locais/remotas |
| `02-claudeopen-tools-mcp-permissions.md` | Lifecycle de tools/MCP, trust e permissões |
| `03-claudeopen-agent-loop-prompts-hooks-streaming.md` | Turn loop, composição de contexto e protocolo de eventos |
| `04-claudeopen-subagents-teams-workflows.md` | Agent registry, resume, teams e fan-out/fan-in |
| `05-claudeopen-ultracode-effort-thinking.md` | Contrato real de `ultracode` |
| `06-claudeopen-memory-context-compaction.md` | Camadas de memória, transcript e handoff |
| `07-codestudio-runner-orchestration.md` | BT runner, recovery, shutdown e strengths |
| `08-codestudio-tools-mcp-tiers-policy.md` | Catálogo, chamadas nested e gates atuais |
| `09-codestudio-subagents-workflows-isolation-ultra.md` | Orquestração interna e lacunas de durabilidade/isolamento |
| `10-codestudio-session-streaming-dashboard.md` | Transporte, replay, backpressure e UX operacional |
| `11-codestudio-memory-prompts-hooks.md` | Memória estruturada, prompt cache e hooks fragmentados |
| `12-capability-parity-matrix.md` | Decisão mecanismo a mecanismo |
| `13-end-to-end-traces.md` | Sequências e invariantes comparáveis |
| `14-target-control-plane-contracts.md` | Arquitetura-alvo e pseudocontratos |
| `15-roadmap-phases-gates.md` | Rollout incremental e gates go/no-go |
| `16-evaluation-benchmark-plan.md` | Benchmarks, métricas e critérios causais |
| `17-risk-register-open-questions.md` | Riscos, mitigação e perguntas não respondidas |
| `18-fase-3-plan.md` | Sequenciamento da implementação da Fase 3 |
| `19-runtime-hardening-corrections.md` | Comparação antes/depois e gates das correções de runtime |
| `DECISIONS.md` | Registro de decisões e alternativas |
| `EVIDENCE_INDEX.md` | Catálogo central de claims e citações |

## Taxonomia rápida

| Marcador | Significado |
|---|---|
| `VERIFIED` | Diretamente comprovado no código/snapshot citado |
| `INFERRED` | Fluxo composto por contratos verificados, sem trace runtime |
| `ABSENT_FROM_SNAPSHOT` | Não observável no corpus; não significa inexistência no produto |
| `LEGACY_DOC` | Documento interno referente a versão/estado anterior |
| `RISK` | Falha possível sustentada pela arquitetura, ainda sem reprodução |
| `BUG` | Comportamento incorreto reproduzido/testado |
| `UX_GAP` | Estado existe, mas não é claramente apresentado/controlável |
| `HYPOTHESIS` | Benefício esperado que exige benchmark |

## Princípios de adoção

1. **Contrato antes de implementação.** Não importar símbolos minificados ou offsets como API.
2. **Reuso antes de substituição.** Evoluir `PermissionGate`, BT runner, hooks, ToolRegistry, stores e SSE atuais.
3. **Segurança independente de descoberta.** Ocultar uma tool não é autorizá-la nem bloqueá-la.
4. **Durabilidade independente de transporte.** SSE é projeção; journal e stores definem retomada.
5. **Eficácia medida, não presumida.** Mais effort, tools ou subagentes não são automaticamente melhores.
6. **Downgrade explícito.** Capabilities não suportadas por modelo, provider ou ambiente devem ser visíveis.
7. **Sem regressão das vantagens internas.** Company Mode, indexer/RAG, skills/plugins, memória estruturada, workflow DAG e `code_exec` são ativos a preservar.

## Documentos relacionados, mas não canônicos para este baseline

- `docs/claude-code-parity.md` cobre OAuth/request parity de Claude Code 2.1.215.
- `docs/claude-desktop-electron-notes.md` cobre uma observação Desktop 1.8089.1.
- `docs/agent-research/COMPARISON.md` é uma comparação histórica multiagente; algumas lacunas ali já foram resolvidas.
- `docs/PROMPTS.md` e `docs/memory-system.md` são as referências atuais para prompts e memória do CodeStudio.

Quando houver conflito, prevalece o código atual e a evidência versionada deste atlas, não uma inferência histórica.
