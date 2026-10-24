# Code Run — simplificação de configuração e capabilities

> Documento histórico anterior à remoção do runtime Rust. Os caminhos e resultados descrevem o checkpoint da época; consulte o [estado atual](../runtime-retirement.md).

> **Status:** P0-P2 e bridge P3 local implementados; B2 físico completo; P3 físico/P4 pendentes
> **Baseline de código:** `7e79171d4c9a98397d3f47d9437d890e9316dc1d`
> **Snapshot operacional:** 2026-08-05
> **Escopo:** configuração do code-run, tools, skills, plugins e MCP
> **Arquitetura superior:** [Registro de remoção do runtime](../runtime-retirement.md)

## 1. Resultado pretendido

O code-run deixa de ser uma coleção de branches controlados por `process.env`
e passa a ter:

1. uma política tipada, resolvida uma vez por `AgentRunAttempt`;
2. defaults de produto que não podem ser desligados acidentalmente;
3. um catálogo único de capabilities para tools nativas, ToolHost, MCP,
   plugins e skills;
4. uma projeção pequena, determinística e mensurável para o modelo;
5. rollout compatível com o novo runtime Rust, sem reestruturar o executor
   TypeScript legado como pré-requisito;
6. remoção comprovada de flags, settings, branches, telemetria e dados mortos.

O objetivo não é renomear 208 variáveis de ambiente para outro objeto. É
reduzir drasticamente a superfície configurável e eliminar estados que não
deveriam existir.

## 2. Documentos

| Documento | Conteúdo |
|---|---|
| [`01-current-state-audit.md`](./01-current-state-audit.md) | Inventário e evidências do runtime atual |
| [`02-runtime-configuration-spec.md`](./02-runtime-configuration-spec.md) | Autoridade, schema, defaults e destino das flags |
| [`03-capability-system-spec.md`](./03-capability-system-spec.md) | Catálogo/projeção para tools, skills, plugins e MCP |
| [`04-migration-validation-plan.md`](./04-migration-validation-plan.md) | Fases, gates, benchmarks, rollback e retirada |
| [`05-flag-disposition-register.md`](./05-flag-disposition-register.md) | Registro de disposição por família e exceções confirmadas |
| [`06-oss-engine-bakeoff-spec.md`](./06-oss-engine-bakeoff-spec.md) | Spike isolado para motores OSS e critérios de adoção/rejeição |
| [`07-oss-engine-bakeoff-results.md`](./07-oss-engine-bakeoff-results.md) | Evidências executáveis e decisão provisória do bake-off |
| [`08-codex-supervised-b2.md`](./08-codex-supervised-b2.md) | Port físico Codex no runner, prova B2 e limites da certificação |
| [`09-oss-engine-decision.md`](./09-oss-engine-decision.md) | ADR de adapter substituível; sem fork e sem cutover antes do P3 |
| [`10-implementation-report.md`](./10-implementation-report.md) | Estado executado, métricas, testes e gates restantes para produção |
| [`11-p3-local-host-capability.md`](./11-p3-local-host-capability.md) | Bridge real `ToolRegistry` -> `HostCapability`, corpus local e limites do gate |

## 3. Decisões vinculantes

Estas decisões governam a implementação iniciada após aprovação explícita. O
estado executado e as exceções ainda temporárias estão no documento 10.

### CRR-001 — Uma autoridade por attempt

Engine, ToolHost e Provider Gateway NÃO DEVEM consultar `process.env` durante
uma attempt. Recebem uma `ResolvedRuntimePolicy` imutável, versionada, com
proveniência e digest.

### CRR-002 — Env deixa de ser produto

Variável de ambiente permanece somente para bootstrap, segredo, diagnóstico ou
um kill switch operacional de emergência. Algoritmo, comportamento normal,
capacidade e limite de agente não são administrados como centenas de env vars.

### CRR-003 — Default é comportamento real

Quando catálogo da UI, `.env` local e fallback do código discordarem, o oracle
é o valor realmente resolvido pelo runtime no baseline. Override explícito e
válido é migrado; default meramente exibido não ganha autoridade.

### CRR-004 — Segurança não é feature flag

Policy Engine, fencing, approvals, reparo de transcript, tuple-hash, doom-loop,
failure-streak, dominance, read coverage, limits de output e cleanup de processo
não podem ser desligados por configuração comum.

### CRR-005 — Catálogo, autorização e projeção são distintos

- o host possui um catálogo completo e versionado;
- a attempt possui um conjunto autorizado imutável;
- o modelo recebe uma projeção pequena desse conjunto.

Descoberta pode revelar uma capability já autorizada no próximo turno, mas não
pode conceder autorização nem inserir silenciosamente uma capability nova na
attempt.

### CRR-006 — Uma descoberta universal

`find_tools`, `expand_toolset`, `list_skill_namespaces`, `get_skills_list`,
`get_skill_content` e `invoke_skill` convergem para um único contrato de
catálogo. Aliases só existem durante a janela de compatibilidade e produzem
telemetria de depreciação.

### CRR-007 — MCP tardio não muta attempt

Servidor MCP que fica pronto após o snapshot publica uma nova revisão de
catálogo para a próxima attempt. O runtime não reconecta nem repete uma operação
mutante aceita e não muda o capability-set em silêncio.

### CRR-008 — Sem preflight LLM no caminho crítico padrão

Seleção inicial de capabilities e skills deve ser local, determinística e
bounded. Um preflight por LLM só pode permanecer como experimento fora do
caminho crítico se provar ganho de resultado maior que custo, latência e falha.

### CRR-009 — Legado é oracle, não destino

O programa implementa estes contratos no runtime Rust/Host descrito pela
arquitetura superior. O executor TypeScript recebe somente bridges necessários
para shadow, comparação, fallback ou correção de risco de dados/segurança.

### CRR-010 — Remoção é parte da conclusão

Não basta ignorar flags antigas. A conclusão exige remover consumers, catálogo
da UI, aliases, rows obsoletas, documentação, telemetria e branches mortos,
mantendo apenas migrations históricas necessárias a upgrades.

## 4. Guardrails de promoção

A implementação permanece isolada em worktree e não altera o runtime ativo. O
B2 físico prova a composição do Codex, e a bridge P3 local liga o catálogo
selado aos executores reais de filesystem, shell e HTTP, além dos handlers
atuais de MCP/plugin/indexer/skill/subagente/Company. Isso ainda não substitui
o corpus P3 físico no build instalado.

Antes do cutover ainda é obrigatório:

- executar o corpus P3 físico restante com MCP/plugins externos e fluxos
  completos de subagentes/Company; filesystem, shell e HTTP locais já foram
  exercitados pela bridge;
- provar restart/recovery sem efeito duplicado;
- executar canário e rollback no build instalado;
- reiniciar o runtime somente em janela que preserve as sessões ativas;
- registrar os receipts de promoção/rollback das quatro rollouts temporárias.

