# 17 — Registro de riscos e questões abertas

## Objetivo

Este registro separa:

- riscos comprovados pela arquitetura atual;
- bugs somente quando reproduzidos;
- gaps de UX;
- hipóteses que exigem benchmark;
- itens ausentes do snapshot ClaudeOpen;
- decisões que bloqueiam planos futuros.

Nenhum item `RISK` deve ser apresentado como incidente já ocorrido sem evidência adicional. Nenhum item `ABSENT_FROM_SNAPSHOT` deve ser convertido em claim negativo sobre o produto Claude.

## 1. Escala

### Probabilidade

- **Alta** — o mecanismo atual torna o cenário comum ou diretamente alcançável.
- **Média** — caminho plausível, mas depende de timing/configuração.
- **Baixa** — requer condições incomuns ou controles já reduzem exposição.
- **Unknown** — falta evidência/runtime trace.

### Impacto

- **Crítico** — unauthorized effect, secret exposure, perda irreversível ou corrupção ampla.
- **Alto** — perda/duplicação de trabalho, recovery incorreto, regressão severa.
- **Médio** — custo, latência, UX ou manutenção materialmente pior.
- **Baixo** — inconveniência localizada/reversível.

### Prioridade

- **P0** — bloqueia fundação/rollout.
- **P1** — mitigar antes de default-on do domínio.
- **P2** — tratar após foundations ou conforme telemetry.
- **Defer** — depende de informação ou fase futura.

### Status

- **Open**;
- **Mitigated by current code**;
- **Accepted temporarily**;
- **Needs decision**;
- **Needs runtime trace**;
- **ABSENT_FROM_SNAPSHOT**.

## 2. Resumo executivo

| ID | Risco/pergunta | Prob. | Impacto | Pri. | Status | Owner sugerido |
|---|---|---:|---:|---:|---|---|
| R-001 | Copiar símbolos/minified contracts do ClaudeOpen | Média | Alto | P0 | Open | Architecture |
| R-002 | Version drift do snapshot Desktop sem versão declarada | Alta | Médio | P0 | Accepted temporarily | Research/Architecture |
| R-003 | Journal vira reescrita total/eventos ambíguos | Média | Alto | P0 | Open | Runtime/Data |
| R-004 | Journal persiste secrets/prompts sensíveis | Média | Crítico | P0 | Open | Security/Runtime |
| R-005 | Dual write diverge entre journal/stores | Média | Alto | P0 | Open | Runtime/Data |
| R-006 | Command retry duplica side effects após restart | Alta | Alto | P0 | Open | Session Runtime |
| R-007 | Policy Engine duplica gates atuais | Média | Alto | P0 | Open | Security/Agent Runtime |
| R-008 | Grant por tool name autoriza recurso amplo | Média | Crítico | P0 | Open | Security |
| R-009 | Tier confundido com segurança | Média | Alto | P0 | Mitigated by decision | Security/Tooling |
| R-010 | Direct/nested/MCP/plugin policy drift | Média | Alto | P0 | Open | Security/Tooling |
| R-011 | Decision hook reduz managed deny | Baixa | Crítico | P0 | Open | Security/Plugins |
| R-012 | Project hook `node:vm` tratado como sandbox forte | Média | Alto | P1 | Open | Security/Runtime |
| R-013 | AgentRun/workflow resume duplica efeito/step | Alta sem store | Alto | P0 | Open | Agent Platform |
| R-014 | Duas attempts ativas após resume race | Média | Alto | P0 | Open | Agent Platform |
| R-015 | Background espera approval invisível | Baixa atual | Alto | P0 | Mitigated by current code | Agent Runtime/Security |
| R-016 | Fan-out amplia custo/duplicação sem qualidade | Média | Médio | P1 | Needs benchmark | Agent Platform |
| R-017 | Verifier aumenta falso positivo | Média | Alto | P1 | Needs benchmark | Quality/Agent Platform |
| R-018 | Ultra mistura effort/orchestration e oculta downgrade | Alta | Médio | P1 | Open | Agent Platform/Product |
| R-019 | `files` scope é contornado via shell | Alta | Crítico | P0 | Open | Security/Environment |
| R-020 | Lease ausente cai no checkout principal | Média | Crítico | P0 | Open | Environment Runtime |
| R-021 | Dois agents mutantes compartilham checkout | Média | Alto | P0 | Open | Environment Runtime |
| R-022 | Worktree dirty é perdido no cleanup | Baixa atual | Alto | P0 | Partially mitigated | Environment/Git |
| R-023 | Symlink/junction/TOCTOU escapa da raiz | Média | Crítico | P0 | Open | Security/Filesystem |
| R-024 | Secret/network broker vaza handle/valor | Unknown | Crítico | P0 | Needs threat model | Security/Platform |
| R-025 | Replay live some com bus/process | Alta | Médio | P1 | Accepted temporarily | Session Runtime |
| R-026 | Runtime log é promovido indevidamente a journal | Média | Alto | P0 | Mitigated by decision | Runtime/Data |
| R-027 | EOF limpo interpretado como terminal | Média | Médio | P1 | Open | SSE/Desktop |
| R-028 | Attach replay trim perde state | Baixa com flag off | Alto | P1 | Mitigated by flag | SSE/Desktop |
| R-029 | Projection mostra completed quando interrupted | Média | Alto | P0 | Open | Runtime/Desktop |
| R-030 | Shadow/journal aumenta first-token latency | Média | Médio | P1 | Needs benchmark | Runtime/Performance |
| R-031 | Prompt/capability projection diverge | Média | Médio | P1 | Open | Prompt/Tooling |
| R-032 | Prompt cache regride por conteúdo volátil | Baixa atual | Médio | P1 | Mitigated by current code | Prompt/Performance |
| R-033 | Functional prompt parser quebra por drift | Média | Alto | P1 | Open | Prompt/Quality |
| R-034 | Memória acumula fatos deriváveis/duplicados | Média | Médio | P1 | Partially mitigated | Memory |
| R-035 | Memória stale induz erro | Média | Alto | P1 | Partially mitigated | Memory |
| R-036 | Anti-entropia bloqueia decisão útil | Média | Médio | P1 | Needs benchmark | Memory/Quality |
| R-037 | Compaction checkpoint/journal geram dupla authority | Média | Alto | P0 | Open | Runtime/Memory |
| R-038 | Handoff textual substitui stores e perde estado | Média | Alto | P1 | Open | Agent Platform/Memory |
| R-039 | Supervisor entra em crash loop | Média | Alto | P1 | Open | Runtime Platform |
| R-040 | Remote executor recebe credential durável | Unknown | Crítico | P0 | Needs threat model | Security/Remote |
| R-041 | Plugin não declarado herda capability | Média | Crítico | P0 | Open | Plugins/Security |
| R-042 | Updater reinicia sem checkpoint/read compatibility | Unknown | Alto | P1 | Open | Desktop/Release |
| R-043 | Computer use controla janela errada/stale | Unknown | Crítico | P0 | Defer | Security/Desktop |
| R-044 | Claims de eficácia confundem modelo com mecanismo | Alta | Alto | P0 | Mitigated by benchmark plan | Evaluation |
| R-045 | Documentação envelhece e vira nova fonte de drift | Alta | Médio | P1 | Open | Architecture/Docs |
| R-046 | Mudanças concorrentes invalidam line refs | Alta | Médio | P0 | Open | Docs/CI |
| R-047 | Company/indexer/RAG/skills/plugins regridem | Média | Alto | P0 | Open | Cross-platform |
| R-048 | Thinking/telemetry expõe dados sensíveis | Média | Crítico | P0 | Open | Security/Observability |
| R-049 | Exactly-once é prometido para efeitos externos | Média | Alto | P0 | Open | Architecture/Runtime |
| R-050 | Backend Cowork/remote é inferido além do snapshot | Alta | Alto | P0 | Mitigated by method | Research/Product |

## 3. Proveniência e reverse engineering

### R-001 — Símbolos desminificados viram APIs-alvo

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** nomes como `Q_e`, `NVy`, `Gq` e offsets são artefatos do bundle, não contratos públicos. Implementá-los literalmente cria acoplamento a uma versão e semântica inferida.
- **Evidência:** o corpus declara reorganização/desminificação e manifesto de offsets: `claudeopen/claude-code-src/README.md:1-18`.
- **Mitigação:** contratos próprios de domínio em [14-target-control-plane-contracts.md](./14-target-control-plane-contracts.md); citações sempre incluem versão/linha/role/confidence.
- **Gate:** code review rejeita nomes/offsets minificados como public API.
- **Residual:** comportamento interno pode ter detalhes não observados mesmo com contrato equivalente.

### R-002 — Desktop sem versão declarada

- **Classificação:** LIMIT/RISK.
- **Probabilidade/impacto:** Alta/Médio.
- **Problema:** `asar-src` não declara a versão do app; misturá-lo com notas 1.8089.1 criaria baseline falso.
- **Evidência:** `claudeopen/asar-src/README.md:1-27`.
- **Mitigação:** referir sempre “snapshot Desktop reorganizado, versão não declarada”; notas históricas ficam não canônicas.
- **Gate:** toda claim Desktop preserva esse qualifier.

### R-050 — Backend remoto inferido além do corpus

- **Classificação:** ABSENT_FROM_SNAPSHOT.
- **Problema:** Cowork/dispatch remoto é classificado no snapshot, mas o serviço receptor, data plane, credentials e consistency protocol não estão presentes.
- **Evidência:** `claudeopen/asar-src/README.md:16-18`.
- **Mitigação:** remote/Cowork do roadmap usa threat model e contratos próprios; não recebe score de paridade.
- **Gate:** nenhuma claim “ClaudeOpen garante X remotamente” sem fonte adicional.

## 4. Journal, commands e consistência

### R-003 — Event sourcing vira reescrita total

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** tentar reconstruir transcript, memory, tasks e toda state exclusivamente de eventos novos pode descartar stores maduros e atrasar o programa.
- **Mitigação:** journal registra lifecycle classes A–C; transcript/memory continuam bounded contexts; rollout mirror/shadow.
- **Gate:** primeira entrega não altera read path nem BT.
- **Rollback:** desligar mirror; tabelas aditivas permanecem.

### R-004 — Journal persiste conteúdo sensível

- **Classificação:** RISK de segurança.
- **Probabilidade/impacto:** Média/Crítico.
- **Problema:** tool inputs/results, prompts, MCP instructions e environment data podem conter secrets/PII/code.
- **Mitigação:** redaction antes do append; secret refs; payload classes; content-addressed refs com ACL; retenção por event class.
- **Gate:** fixtures de secret scan e export; zero raw secret.
- **Owner:** Security/Runtime Data.

### R-005 — Dual-write diverge

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** command/session DB, transcript e journal podem confirmar em ordens diferentes.
- **Mitigação:** transactional outbox quando possível; idempotent projections; reconciliation states; não prometer distributed transaction.
- **Gate:** fault injection em cada ACK boundary; projection agreement.

### R-006 — Retry após restart duplica side effect

- **Classificação:** RISK comprovado por limite do contrato atual.
- **Probabilidade/impacto:** Alta/Alto.
- **Evidência:** `RecentMessageKeys` é in-memory, TTL/LRU e WeakRef: `codestudio_mcp-codebase/apps/http-api/server/routes/recent-message-keys.ts:5-34`, `codestudio_mcp-codebase/apps/http-api/server/routes/recent-message-keys.ts:46-104`.
- **Mitigação:** durable command ledger, payload hash conflict e result refs.
- **Gate:** repetir commands após HTTP/worker/app restart com zero duplicate effect.

### R-037 — Checkpoint e journal como authorities concorrentes

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** compaction chapters/checkpoints já definem continuidade; um journal ingênuo pode tentar reconstruir contexto por eventos incompletos e contradizer boundaries.
- **Evidência:** checkpoint flusha e alinha o prefixo do DB antes do chapter commit: `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3312-3358`.
- **Mitigação:** journal referencia checkpoint/chapter IDs e terminal status; transcript/chapter store continua authority do conteúdo.
- **Gate:** três compactações + restart + replay produzem o mesmo visible context.

### R-049 — Claim de exactly-once

- **Classificação:** RISK de arquitetura/comunicação.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** filesystem, shell, MCP e network effects não são transações do journal. ACK loss pode deixar efeito aplicado com terminal desconhecido.
- **Mitigação:** `SideEffectContract` por capability com forwarding da idempotency key, estágios seguros de retry, outcome probe/compensation explícitos e estado `outcome_unknown`; intent/terminal events; mutação genérica nunca sofre retry automático.
- **Gate:** documentação/API nunca promete exactly-once genérico; ACK perdido após dispatch não reexecuta efeito não idempotente e converge para probe/reconciliation ou `outcome_unknown`.

## 5. Policy, permissions e hooks

### R-007 — Novo Policy Engine vira quarto gate

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Evidência:** regras estáticas em `core/policy.ts`, interação em `PermissionGate` e gates de task/guards no dispatch: `codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:205-248`, `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:163-270`, `codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:464-510`.
- **Mitigação:** adapters e shadow comparison; um result contract, sem bypass do ordering atual.
- **Gate:** 100% equivalência nas regras comuns antes de enforcement.

### R-008 — Grants amplos por tool name

- **Classificação:** RISK de segurança.
- **Probabilidade/impacto:** Média/Crítico.
- **Evidência:** “always allow” adiciona `toolName` ao set: `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:247-250`.
- **Mitigação:** canonical `ResourceBinding` antes da decisão; grants por resource constraint, duration, actor e capability/policy/environment/lease versions. Approval `once` vincula decision/tool-use/effective-input hash/binding/fencing epoch/nonce/expiry e é consumido por compare-and-set.
- **Gate:** path/command/network/database fixtures mostram que grant não escapa do recurso; alteração de input, symlink/lease/version, replay, expiry ou consumo concorrente não executa e exige nova decisão.

### R-009 — Tier como autorização

- **Classificação:** RISK conceitual, mitigado por decisão.
- **Evidência:** o próprio código declara visibility, not authority: `codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:627-633`; `code_exec` pode alcançar tools fora do tier visível sob policy: `codestudio_mcp-codebase/packages/code-agent/src/tools/code-exec.ts:90-106`.
- **Mitigação:** D-005, naming de projections e dashboard.
- **Gate:** testes e docs distinguem registered/visible/eligible/authorized.

### R-010 — Drift direct/nested/MCP/plugin

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** nested replica policy; profile filters e MCP defaults adicionam branches.
- **Evidência:** nested policy/permission em `codestudio_mcp-codebase/packages/code-agent/src/tools/code-exec.ts:611-688`; MCP externo sem metadata assume mutating em `codestudio_mcp-codebase/packages/code-agent/src/core/tool.ts:77-108`.
- **Mitigação:** PolicyRequest + ResourceBinding comuns e parity matrix automatizada. Metadata externa nunca reduz classificação local; MCP/plugin/remote usa mutating/high-risk e sem idempotência/network/secrets por default até override/attestation local.
- **Gate:** decisão idêntica para invocation context equivalente; servidor que mente sobre mutabilidade, network, secrets ou idempotência permanece na postura conservadora.

### R-011 — Hook contorna managed deny

- **Classificação:** RISK de segurança.
- **Probabilidade/impacto:** Baixa/Crítico.
- **Mitigação:** hook é uma source com precedência inferior; pode adicionar constraint ou deny, nunca reduzir deny superior; patch revalidado.
- **Gate:** precedence/adversarial hook tests.

### R-012 — `node:vm` chamado de sandbox forte

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Evidência:** project hooks executam `Script` no processo com globals limitados e timeout de 200 ms: `codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:41-71`.
- **Mitigação:** trust levels; project/plugin code não confiável em worker/process/container; `node:vm` apenas language isolation/timeout.
- **Gate:** security review/red-team antes de decision hooks de projeto/plugin.

### R-015 — Background approval invisível

- **Classificação:** risco mitigado atualmente.
- **Evidência:** `forBackground` transforma prompt em deny: `codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:178-197`.
- **Mitigação:** preservar como invariante do Policy Engine.
- **Gate:** background direct/nested/MCP `ask` retorna deny estruturado.

## 6. AgentRun, workflow e Ultra

### R-013 — Resume duplica side effects/steps

- **Classificação:** RISK.
- **Probabilidade/impacto:** Alta sem durable store/Alto.
- **Evidência:** subagent resume e workflow são process-scoped: `codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-resume-registry.ts:1-15`, `codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-tool.ts:1-8`.
- **Mitigação:** AgentRun attempts, durable workflow step terminal, `SideEffectContract`, idempotency/reconciliation e dual-write/backprojection durante a janela de rollback.
- **Gate:** crash after every step/tool boundary; completed never relaunches; rollback em `queued/running/waiting/completed` não torna output novo invisível nem relança efeito.

### R-014 — Attempts concorrentes

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Mitigação:** executor lease com heartbeat/expiry, CAS sobre run/attempt versions e fencing epoch monotônico; provider/tool/terminal boundaries exigem epoch atual.
- **Gate:** two-host concurrent resume permite um executor vigente; owner antigo que retorna depois do takeover é fenceado antes de qualquer provider call, tool side effect ou terminal commit.

### R-016 — Fan-out sem ganho

- **Classificação:** HYPOTHESIS/RISK de custo.
- **Probabilidade/impacto:** Média/Médio.
- **Problema:** agentes paralelos podem duplicar investigação e aumentar tokens/context synthesis.
- **Mitigação:** independence validation, budgets, bounded digests, useful-result telemetry.
- **Gate:** factorial/ablation em `16-evaluation-benchmark-plan.md`; no default-on sem ganho causal.

### R-017 — Verifier falso positivo

- **Classificação:** HYPOTHESIS/RISK de qualidade.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** verifier pode rejeitar correções válidas ou amplificar bias do mesmo modelo.
- **Mitigação:** independent capability/model quando necessário; `uncertain`; oracle dataset; selective risk policy.
- **Gate:** precision/recall/false-positive threshold por claim class.

### R-018 — Ultra monolítico/downgrade invisível

- **Classificação:** UX_GAP/RISK.
- **Probabilidade/impacto:** Alta/Médio.
- **Evidência:** CodeStudio usa host mode/keyword e sentinel `ultra`: `codestudio_mcp-codebase/packages/code-agent/src/sessions/execution-mode.ts:15-45`; ClaudeOpen separa xhigh e workflow flag: `claudeopen/claude-code-src/agent/workflow.js:9027-9054`.
- **Mitigação:** requested/effective dimensions e `UltraPreset` versionado.
- **Gate:** unsupported models mostram downgrade/deny; factorial benchmark identifica cohorts úteis.

### R-047 — Regressão de Company/ecossistema

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** contrato comum pode acidentalmente reduzir Company, indexer/RAG, skills/plugins ou `code_exec` ao menor denominador comum.
- **Mitigação:** adapters, parity fixtures e “preserve CodeStudio” como acceptance criterion.
- **Gate:** G21 de `16-evaluation-benchmark-plan.md` em toda fase relevante.

## 7. Environment, filesystem, shell e secrets

### R-019 — Shell contorna `files`

- **Classificação:** RISK de segurança comprovado pelo contrato.
- **Probabilidade/impacto:** Alta/Crítico.
- **Evidência:** directWriteTools bloqueia apenas cinco tools nativas; `run_command` é observado, não hard-blocked: `codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1287-1345`. O allowlist documenta warning-only: `codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1035-1038`.
- **Mitigação:** environment/lease enforcement no filesystem/shell/process broker, não somente wrapper. Rollback funcional pode desligar o default de worktree, mas rollback do fence bloqueia novos mutating AgentRuns/falha fechado em vez de restaurar warning-only.
- **Gate:** adversarial path/shell suite e ensaio do kill switch; forbidden effect zero mesmo durante rollback.

### R-020 — Fallback para checkout principal

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Crítico.
- **Problema:** um AgentRun cuja lease/worktree desaparece não pode continuar mutando no cwd pai.
- **Referência comparativa:** ClaudeOpen resume pode cair no parent cwd quando worktree some: `claudeopen/claude-code-src/agent/loop.js:688-697`; o atlas rejeita esse fallback para writes.
- **Mitigação:** missing/stale lease fail closed; read-only fallback requer policy explícita.
- **Gate:** remover worktree externamente durante run e verificar deny/interrupted.

### R-021 — Writers compartilham checkout

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** `files` e worktree tools manuais não garantem checkout exclusivo por child.
- **Mitigação:** exclusive WorkspaceLease por AgentRun; scheduler não inicia segundo writer sem target separado.
- **Gate:** collision fixture com dois agents.

### R-022 — Perda de worktree dirty

- **Classificação:** RISK parcialmente mitigado.
- **Probabilidade/impacto:** Baixa/Alto.
- **Evidência:** `exit_worktree` recusa remoção dirty sem `discard_changes: true` e restaura cwd antes: `codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:209-238`.
- **Mitigação:** preservar dirty guard; snapshot-then-remove; cleanup policy e audit.
- **Gate:** crash/rollback/cleanup nunca apaga diff sem explicit action.

### R-023 — Symlink/junction/TOCTOU

- **Classificação:** RISK de segurança.
- **Probabilidade/impacto:** Média/Crítico.
- **Mitigação:** canonical path no broker, no-follow/default policy, open-handle validation quando possível, Windows reparse tests e post-validation creation tests.
- **Gate:** adversarial suite G05/G19.

### R-024 — Secret/network broker

- **Classificação:** RISK/Needs threat model.
- **Probabilidade/impacto:** Unknown/Crítico.
- **Problema:** just-in-time handles ainda podem vazar por env, argv, logs, child process, MCP error ou egress redirect.
- **Mitigação:** handle-only default, minimal scopes, redaction, egress broker, process isolation e revoke on terminal.
- **Gate:** secret/network exfiltration suite antes de remote/default isolation.

## 8. Streaming, projection e dashboard

### R-025 — Replay live desaparece

- **Classificação:** RISK/limite aceito temporariamente.
- **Probabilidade/impacto:** Alta/Médio.
- **Evidência:** bus é in-memory e bounded por 2.000 eventos/8 MiB: `codestudio_mcp-codebase/apps/http-api/coder-bus.ts:29-73`.
- **Mitigação:** journal/projection durable; bus permanece fast live path.
- **Gate:** attach após bus eviction/restart recupera state.

### R-026 — Runtime log promovido a journal

- **Classificação:** risco mitigado por D-003.
- **Evidência:** pula deltas, amostra progress, trunca oversized e persiste best-effort: `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log.ts:23-48`, `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log.ts:121-223`, `codestudio_mcp-codebase/apps/http-api/sse/runtime-event-log-storage.ts:36-139`.
- **Mitigação:** nome/projeção permanecem diagnósticos; journal novo.

### R-027 — EOF limpo versus terminal

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Médio.
- **Evidência:** client retorna em stream close sem terminal para evitar reconnect loop: `codestudio_mcp-codebase/packages/shared/src/sse/ReconnectingSSEClient.ts:90-95`.
- **Mitigação:** domain state/journal reconciliation; phase `disconnected/degraded/interrupted`; não marcar completed por EOF.
- **Gate:** proxy/server EOF fault injection.

### R-028 — Attach trim perde state

- **Classificação:** risco conhecido, mitigado por flag.
- **Probabilidade/impacto:** Baixa com default off/Alto.
- **Evidência:** comentário registra incidente e exige Electron E2E; flag default off: `codestudio_mcp-codebase/apps/http-api/coder-bus.ts:350-359`.
- **Mitigação:** manter flag; full/journal replay comparison.
- **Gate:** G14/G15 antes de default-on.

### R-029 — Projection false completed

- **Classificação:** RISK de durabilidade/UX.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** lag/crash pode deixar session row stale ou reducer interpretar EOF/done fora de ordem.
- **Evidência:** coder UI já disambigua attach 404 via `/state`: `codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:380-409`.
- **Mitigação:** terminal authority/journal, projection cursor, accepted-without-terminal recovery para `interrupted`.
- **Gate:** crash at every boundary; no completed false.

### R-030 — Journal/shadow aumenta latency

- **Classificação:** HYPOTHESIS/RISK performance.
- **Probabilidade/impacto:** Média/Médio.
- **Mitigação:** não journalar deltas no hot path; async outbox onde seguro; p95/p99 instrumentation; cohort.
- **Gate:** first-token/policy/append budgets em `16-evaluation-benchmark-plan.md`.

### UX-001 — Coder não mostra connection phase

- **Classificação:** UX_GAP.
- **Evidência:** Company usa `onPhase`: `codestudio_mcp-codebase/apps/dashboard/hooks/useCompanyStream.ts:535-547`; coder não passa callback: `codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:330-347`.
- **Mitigação:** reutilizar `ConnectionPhaseStrip` semantics e distinguir transport/domain phases.

### UX-002 — Provider complete versus durable/terminal

- **Classificação:** UX_GAP.
- **Evidência:** runtime possui message complete, interaction checkpoint, transcriptFlushed, public terminal e terminal quality posterior: `codestudio_mcp-codebase/packages/code-agent/src/index.ts:2993-3144`, `codestudio_mcp-codebase/packages/code-agent/src/index.ts:3490-3546`.
- **Mitigação:** state taxonomy e timestamps/labels; evitar flicker.

## 9. Prompt, memória e compactação

### R-031 — Prompt/tool set diverge

- **Classificação:** RISK de eficácia/diagnóstico.
- **Probabilidade/impacto:** Média/Médio.
- **Problema:** prompt hints e provider descriptors são montados por pipelines relacionados, mas não um resolved set persistido.
- **Mitigação:** `ResolvedCapabilitySet` com hash e duas projections.
- **Gate:** exact hash equality + A/B tool selection.

### R-032 — Prompt cache regression

- **Classificação:** risco mitigado pelo baseline atual.
- **Evidência:** boundary e regra byte-stable estão documentadas: `codestudio_mcp-codebase/docs/PROMPTS.md:10-38`; implementation sempre emite marker e põe conteúdo volátil abaixo: `codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:640-696`.
- **Mitigação:** snapshot byte-a-byte; capability summary respeita cache class.
- **Gate:** cache hit ratio e static prefix hash.

### R-033 — Functional prompt/parser drift

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Evidência:** quatro prompts têm strict output contracts; docs alertam não renomear fields: `codestudio_mcp-codebase/docs/PROMPTS.md:10-25`.
- **Mitigação:** schema/version, parser fixtures e snapshot tests.
- **Gate:** prompt change não entra sem contract test correspondente.

### R-034 — Memória derivável/duplicada

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Médio.
- **Evidência:** CodeStudio possui supersession/sweeper, mas não foi localizado um veto universal a fatos deriváveis; ClaudeOpen instrui não armazená-los: `claudeopen/claude-code-src/agent/memory.js:413-457`; CodeStudio model em `codestudio_mcp-codebase/docs/memory-system.md:17-37`.
- **Mitigação:** evaluator shadow/warn, scopes e dedupe existentes.
- **Gate:** derive/duplicate rate cai sem false reject acima do limite.

### R-035 — Memória stale causa erro

- **Classificação:** RISK parcialmente mitigado.
- **Probabilidade/impacto:** Média/Alto.
- **Evidência:** referenced file hashes e staleness discount existem: `codestudio_mcp-codebase/docs/memory-system.md:24-37`.
- **Mitigação:** mostrar freshness/provenance; conservative selector; reverify referenced files em high-risk tasks.
- **Gate:** stale-memory error metric não regride e target de redução.

### R-036 — Anti-entropia bloqueia decisão útil

- **Classificação:** HYPOTHESIS/RISK.
- **Probabilidade/impacto:** Média/Médio.
- **Mitigação:** shadow → warn → selective enforce; `uncertain`/override; types `decision/gotcha/procedure` recebem regras próprias.
- **Gate:** labeled dataset e false rejection threshold.

### R-038 — Handoff substitui store

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** um summary textual pode perder pending interaction, exact tool pairing, lease ou policy snapshot.
- **Mitigação:** `HandoffArtifact` com refs/version/hash; bounded digest apenas para contexto.
- **Gate:** cross-instance handoff fidelity fixtures.

## 10. Supervisor, remote, plugins e update

### R-039 — Crash loop

- **Classificação:** RISK.
- **Probabilidade/impacto:** Média/Alto.
- **Problema:** restart automático sem budget pode consumir recursos, repetir setup ou confundir run ownership.
- **Mitigação:** bounded restart/backoff/quarantine e terminalization/reconciliation.
- **Gate:** repeated crash fixture; no infinite restart.

### R-040 — Remote credentials duráveis

- **Classificação:** RISK/Needs threat model.
- **Probabilidade/impacto:** Unknown/Crítico.
- **Mitigação:** host-owned short-lived handles, brokered calls, no raw API keys, mTLS/attestation conforme target. Emergency kill fenceia attempts por epoch e revoga grants/handles imediatamente; somente artifacts inertes são preservados.
- **Gate:** remote worker compromise/rollback simulation; zero durable credential e zero autoridade remota ativa após kill switch.

### R-041 — Plugin capability escalation

- **Classificação:** RISK de segurança.
- **Probabilidade/impacto:** Média/Crítico.
- **Problema:** full registry inheritance ou undeclared MCP/network/secrets pode ampliar authority.
- **Mitigação:** signed manifest/provenance; catalog declaration; isolated host; default deny for undeclared requirement. Manifest/metadata externa é untrusted e jamais reduz a classificação local conservadora.
- **Gate:** malicious plugin suite inclui declaração falsa de read-only, idempotência, network e secret requirements.

### R-042 — Updater sem checkpoint/compatibilidade

- **Classificação:** RISK.
- **Probabilidade/impacto:** Unknown/Alto.
- **Mitigação:** signed package, drain/checkpoint, aditive schemas/events, binary rollback, interrupted recovery.
- **Gate:** update at each run boundary and downgrade/read compatibility tests.

### R-043 — Computer use em janela stale/errada

- **Classificação:** RISK de segurança, Defer.
- **Probabilidade/impacto:** Unknown/Crítico.
- **Mitigação:** app/window-scoped grant, focus confirmation, visual state hash/version, foreground confirmation, broker process.
- **Gate:** red-team de focus stealing, overlays, visual prompt injection e credentials.

## 11. Evaluation, documentação e manutenção

### R-044 — Confundir model gain com orchestration

- **Classificação:** RISK metodológico.
- **Probabilidade/impacto:** Alta/Alto.
- **Mitigação:** factorial/ablation, same model/effort controls e reproduction envelope em `16-evaluation-benchmark-plan.md`.
- **Gate:** claim sem isolamento causal não é promovida.

### R-045 — Atlas envelhece

- **Classificação:** RISK de manutenção.
- **Probabilidade/impacto:** Alta/Médio.
- **Mitigação:** baseline/version no README, evidence index, line audit CI/manual, review trigger por major release, `LEGACY_DOC` para findings resolvidos.
- **Gate:** revisão do atlas ao abrir cada fase ou mudar major/minor relevante.

### R-046 — Line drift e trabalho concorrente

- **Classificação:** RISK.
- **Probabilidade/impacto:** Alta/Médio.
- **Problema:** line references mudam; vários arquivos internos estavam modificados durante a sessão.
- **Mitigação:** re-read antes da escrita, citation path/line audit, evidence index, símbolos/curtas ranges, commit baseline.
- **Gate:** script confirma paths/ranges; amostra semântica manual por tema.

### R-048 — Thinking/telemetry sensível

- **Classificação:** RISK de segurança/privacy.
- **Probabilidade/impacto:** Média/Crítico.
- **Problema:** thinking, prompts e detailed tool payloads podem conter segredos, dados pessoais ou código sensível.
- **Mitigação:** não persistir hidden reasoning no journal; redaction; role-based audit refs; diagnostic sampling; retention policy.
- **Gate:** data classification/security review e secret scan.

## 12. Perguntas abertas por decisão

### 12.1 Command/session

| ID | Pergunta | Bloqueia | Owner sugerido | Como responder |
|---|---|---|---|---|
| Q-001 | Qual é a partition key do journal: session, project ou tenant? | Fase 1 schema/perf | Runtime/Data | prototype + retention/query load test |
| Q-002 | Qual semântica de `expectedSessionVersion` para message injection/approval? | Command ledger | Session Runtime | concurrency model + route traces |
| Q-003 | Por quanto tempo idempotency keys são retidas? | Storage/privacy | Product/Runtime | retry windows + compliance policy |
| Q-004 | Quais event classes bloqueiam o run se append falhar? | Journal critical path | Runtime/Security | event-class threat analysis |
| Q-005 | DB e journal compartilham store ou usam outbox? | Migration/perf | Data Platform | prototype/failure injection |
| Q-006 | Qual maximum recoverable loss é aceitável para token/partial output? | UX/recovery | Product/Runtime | user study + storage budget |

### 12.2 Policy/capabilities/hooks

| ID | Pergunta | Bloqueia | Owner sugerido | Como responder |
|---|---|---|---|---|
| Q-007 | Qual precedence exata entre managed, project, user, session e hook? | Policy Engine | Security/Product | policy RFC + adversarial matrix |
| Q-008 | Quais grants podem ser persistent e quem administra revogação? | Approval UX | Security/Product | threat model + UX study |
| Q-009 | Como capability IDs sobrevivem rename/server migration/plugin upgrade? | Catalog schema | Tooling/Plugins | namespace/version RFC |
| Q-010 | Que metadata MCP pode ser confiada ao server? | MCP catalog | Security/Integrations | signed/local override model |
| Q-011 | Quais decision hooks podem fail open versus closed? | Hook bus | Security/Plugins | stage classification |
| Q-012 | Project hooks confiáveis continuam em-process ou todos vão para worker? | Isolation/perf | Runtime/Security | threat model + latency prototype |
| Q-013 | Como `inputPatch` aciona reavaliação de policy? | Policy correctness | Security/Tooling | formal ordering/tests |

### 12.3 Agent/workflow/Ultra

| ID | Pergunta | Bloqueia | Owner sugerido | Como responder |
|---|---|---|---|---|
| Q-014 | Qual store e retention para transcripts de subagentes? | Durable AgentRun | Agent Platform/Data | storage/privacy benchmark |
| Q-015 | Quando resume cria attempt novo versus retorna result existente? | Lifecycle | Agent Platform | state machine RFC |
| Q-016 | Parent stop faz cascade, detach ou prompt? | Background semantics | Product/Agent Platform | preset/policy decision |
| Q-017 | `partial` satisfaz quais dependências? | Durable workflow | Agent Platform | typed output contracts |
| Q-018 | Como transferir AgentRun/lease entre Company master e workflow? | Contract convergence | Company/Agent Platform | identity/ownership design |
| Q-019 | Quais tasks justificam verifier independente? | Ultra/quality | Evaluation/Product | risk labels + benchmark |
| Q-020 | Qual max parallelism/depth por provider/org/environment? | Scheduler | Platform/Product | capacity/cost benchmark |
| Q-021 | `ultracode` keyword fica por quanto tempo como compatibilidade? | Migration UX | Product | telemetry/adoption plan |

### 12.4 Environment/remote

| ID | Pergunta | Bloqueia | Owner sugerido | Como responder |
|---|---|---|---|---|
| Q-022 | Worktree é default para toda mutation ou só subagentes/Ultra? | Fase 5 default | Product/Environment | latency/usability cohort |
| Q-023 | Quem renova/expira lease e qual heartbeat? | Lease correctness | Environment Runtime | failure model/prototype |
| Q-024 | Como reconciliar dirty worktree orphaned? | Cleanup/recovery | Git/Environment | lifecycle RFC |
| Q-025 | Qual sandbox driver é production-grade por OS? | Sandbox default | Platform | driver conformance suite |
| Q-026 | Network broker opera por proxy, syscall/container policy ou ambos? | Egress security | Security/Platform | threat model/prototypes |
| Q-027 | Como secret handle chega a stdio MCP/CLI sem aparecer em argv/env/log? | Integrations | Security | broker design/red-team |
| Q-028 | Qual trust/attestation do remote executor? | Remote launch | Security/Remote | architecture/threat model |
| Q-029 | Como clock/cursor/correlation funcionam cross-host? | Remote events | Runtime/Observability | protocol prototype |

### 12.5 Streaming/dashboard

| ID | Pergunta | Bloqueia | Owner sugerido | Como responder |
|---|---|---|---|---|
| Q-030 | O coder store adota as mesmas connection phases de Company? | UX implementation | Desktop | component/state design |
| Q-031 | Como mostrar `persisting` sem flicker em runs rápidos? | Boundary UX | Product/Desktop | usability prototype |
| Q-032 | Cursor durable é mantido por tab, device ou user/session? | Cross-device replay | Desktop/Runtime | product/data model decision |
| Q-033 | Qual policy para replay gap/large payload? | SSE projection | Runtime/Desktop | load test + UX design |
| Q-034 | Attach trim atual pode virar default ou journal o substitui? | Optimization | Performance/Desktop | Electron E2E comparison |

### 12.6 Memory/prompt

| ID | Pergunta | Bloqueia | Owner sugerido | Como responder |
|---|---|---|---|---|
| Q-035 | Anti-derivable evaluator bloqueia, avisa ou reduz importance? | Memory write policy | Memory/Product | labeled benchmark |
| Q-036 | Como apresentar provenance/freshness sem sobrecarregar o chat? | Memory UX | Desktop/Memory | UX study |
| Q-037 | Qual schema/version para functional prompt contracts? | Prompt governance | Prompt/Quality | prompt registry RFC |
| Q-038 | Handoff inclui quais digests versus refs? | Cross-instance resume | Agent/Memory | failure/size benchmark |
| Q-039 | Como invalidar capability/prompt cache quando hook/plugin muda? | Cache correctness | Prompt/Tooling | version/hash design |

### 12.7 ClaudeOpen ausente/unknown

| ID | Item não observável | Impacto no atlas | Ação |
|---|---|---|---|
| Q-040 | Backend Cowork/remote data plane | Não comparar durability/security remoto | fonte adicional ou implementação própria |
| Q-041 | Server-side experiment assignment | Não inferir flags efetivas gerais | runtime telemetry/documentation pública |
| Q-042 | Credential storage/rotation remoto | Não copiar auth assumptions | threat model próprio |
| Q-043 | Production supervisor/restart policy remoto | Não atribuir recovery guarantee | source/runtime trace adicional |
| Q-044 | Métricas internas de efficacy/cost | Não declarar superioridade causal | benchmark próprio |
| Q-045 | Desktop build/version do snapshot | Não misturar com 1.8089.1 | recuperar metadata externa se disponível |
| Q-046 | Computer-use broker guarantees | Defer Fase 7 | red-team/design próprio |

## 13. Riscos aceitos temporariamente

### A-001 — Replay live process-scoped

Aceito enquanto journal/projection não existe, porque:

- bus possui count/byte caps;
- reconnect same-process funciona;
- transcript store e crash UI reduzem impacto;
- o risco está documentado e a Fase 1/4 o endereça.

Não autoriza chamar o replay de durable.

### A-002 — Subagent/workflow resume process-scoped

Aceito para baseline atual, porque o próprio contrato declara o limite e fornece repair/caps. Não autoriza default de tarefas longas críticas sem expectativa de restart recovery.

### A-003 — Shell scope warning-only

Aceito apenas como estado legado já conhecido; **bloqueia** chamar `files` de sandbox completa e bloqueia qualquer rollout que amplie autonomy/remoteness antes da Fase 5.

### A-004 — Ultra monolítico na UX atual

Aceito enquanto `UltraPreset v2` não existe; nenhuma claim causal é permitida e downgrade deve ser investigado no plano futuro.

## 14. Riscos que bloqueiam remote/computer use

Os seguintes itens devem estar mitigados antes de abrir remote mutante ou computer use:

- R-004 journal/secret redaction;
- R-007/R-010 policy chokepoint/parity;
- R-008 resource grants;
- R-011 decision hook precedence;
- R-019 shell escape;
- R-020/R-021 lease fail-closed/exclusivity;
- R-023 path/reparse/TOCTOU;
- R-024 network/secret broker;
- R-039 supervisor crash loop;
- R-040 remote credentials;
- R-041 plugin escalation;
- R-048 sensitive telemetry.

## 15. Review cadence

### Reabrir o registro quando

- começar qualquer fase funcional;
- mudar major/minor do CodeStudio ou snapshot Claude;
- ocorrer incidente de worker/session/tool/policy;
- adicionar provider, MCP transport, plugin trust level ou environment target;
- alterar prompt/memory contract;
- promover flag shadow → enforce/default;
- executar benchmark que confirme/rejeite hipótese.

### Update obrigatório por risco

- status e data;
- evidence/incidents novos;
- mitigation implementada;
- test/gate correspondente;
- residual risk;
- owner bounded context;
- decisão `accept | mitigate | transfer | reject/defer`.

## 16. Critério de fechamento

Um risco só fecha quando:

1. a mitigation existe no contrato e no runtime relevante;
2. o gate automatizado/adversarial passa;
3. rollout/rollback foi ensaiado;
4. telemetry não mostra residual acima do threshold;
5. documentação/UX não faz claim mais forte que a garantia;
6. um owner aceita explicitamente o residual.

Itens `ABSENT_FROM_SNAPSHOT` fecham somente com fonte suficiente ou decisão de construir/abandonar o mecanismo próprio; ausência continuada não é “resolvida” por inferência.
