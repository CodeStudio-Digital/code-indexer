# Code Run — simplificação de configuração e capabilities

> **Status:** planejamento para revisão; implementação ainda não autorizada  
> **Baseline de código:** `c817f13ec0fd4073db7a70e3c07f3714a3a54e4e`  
> **Snapshot operacional:** 2026-08-04  
> **Escopo:** configuração do code-run, tools, skills, plugins e MCP  
> **Arquitetura superior:** [`../rust-agent-runtime/README.md`](../rust-agent-runtime/README.md)

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

## 3. Decisões vinculantes desta proposta

Enquanto estes documentos estiverem em revisão, “vinculante” significa
“necessário para aprovar a execução”, não autorização para alterar o runtime.

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

## 4. Fora de escopo antes da aprovação

- alterar comportamento do runtime atual;
- mudar defaults em produção;
- remover settings ou rows SQLite;
- reescrever `ToolRegistry` no legado;
- reiniciar Electron/http-api ou interromper sessões;
- iniciar rollout Rust;
- prometer melhoria de qualidade sem benchmark executável.

## 5. Critério de aprovação das specs

Antes da primeira mudança de execução, a revisão precisa confirmar:

- qual snapshot representa a configuração atual;
- quais overrides são realmente política de produto;
- quais comportamentos ficam permanentemente ligados ou desligados;
- o contrato do catálogo/projeção e sua compatibilidade com providers;
- gates de equivalência, segurança, desempenho e rollback;
- ownership e prazo de remoção de cada compatibilidade temporária.

