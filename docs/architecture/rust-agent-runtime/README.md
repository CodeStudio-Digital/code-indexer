# Rust Agent Runtime — especificação normativa

> **Status:** especificação final para implementação  
> **Versão:** 1.8.0
> **Data-base:** 2026-07-30
> **Autoridade:** este diretório governa o novo runtime de agentes em Rust  
> **Checklist executiva:** [IMPLEMENTATION-CHECKLIST.md](./IMPLEMENTATION-CHECKLIST.md)

## 1. Objetivo

Este corpus especifica o substituto nativo do runtime de agentes do CodeStudio.
A mudança não é um port linha a linha de `packages/code-agent`: é um novo data
plane em Rust, isolado por tentativa de execução, com memória limitada pelo
sistema operacional, lifecycle durável e fronteiras serializáveis.

O resultado pretendido é:

- crescimento de memória previsível por execução e subagente;
- eliminação de isolates V8 permanentes por sessão;
- cancelamento e reaping que não dependem de cooperação do código travado;
- atribuição de CPU, memória, processos e disco por `AgentRunAttempt`;
- retomada a partir de checkpoint, sem manter a sessão inteira em RAM;
- compatibilidade funcional comprovada antes de retirar o runtime legado.

## 2. Decisões vinculantes

| Decisão | Escolha |
|---|---|
| Linguagem do novo motor | Rust |
| Unidade de execução física | Um processo single-tenant por `AgentRunAttempt` |
| Fault/resource domain | Limite por attempt e orçamento agregado por run-tree |
| Processo permanente | `agentd-supervisor`, sem transcript nem grafo de agente |
| Control plane | TypeScript |
| Persistência de sessão | Rust `agent-session-store`: bundle filesystem single-writer por sessão |
| SQLite não relacionado a sessão | Permanece fora do runtime Rust e com seus owners atuais |
| Providers na primeira entrega | Provider Gateway TypeScript |
| Tools nativas iniciais | filesystem, search, patch, Git, processo e HTTP |
| `code_exec` | subprocesso descartável e limitado; nunca embutido no daemon |
| Protocolo cross-language | Protobuf gerado, sobre Named Pipe/Unix socket |
| Estado grande | spool/checkpoint content-addressed fora do heap |
| Rollout | replay/shadow, canário por run e fallback controlado |
| Runtime legado | oracle temporário e fallback; sem programa de remendos |
| Indexador e RAG docs | Trilho paralelo `indexd` em Rust, gated por benchmark (doc 09) |

## 3. Linguagem normativa

Os termos abaixo têm significado obrigatório:

- **DEVE / MUST:** requisito de promoção. Não cumprir bloqueia o gate.
- **NÃO DEVE / MUST NOT:** comportamento proibido.
- **DEVERIA / SHOULD:** requisito esperado; exceção exige ADR e evidência.
- **PODE / MAY:** escolha de implementação compatível.

Um checkbox só pode ser marcado quando houver evidência vinculada: PR, teste,
benchmark, trace, relatório de chaos ou artefato de build. Código existente sem
prova executada não conclui um item.

## 4. Mapa dos documentos

| Documento | Conteúdo normativo |
|---|---|
| [DECISIONS.md](./DECISIONS.md) | Registro curto das decisões vinculantes e seu status |
| [ADR-001-rust-session-filesystem-authority.md](./ADR-001-rust-session-filesystem-authority.md) | Rust como writer físico dos bundles de sessão |
| [ADR-002-native-host-bridge.md](./ADR-002-native-host-bridge.md) | Núcleo Rust e wrapper Node-API do owner físico Host |
| [00-scope-decisions.md](./00-scope-decisions.md) | Escopo, termos, ownership, decisões e não objetivos |
| [01-runtime-supervisor-and-isolation.md](./01-runtime-supervisor-and-isolation.md) | Topologia de processos, lifecycle, budgets, reaper e isolamento por SO |
| [02-host-agentd-protocol.md](./02-host-agentd-protocol.md) | IDL, transporte, mensagens, sequencing, cancelamento e compatibilidade |
| [03-agent-engine-and-subagents.md](./03-agent-engine-and-subagents.md) | Loop do agente, contexto, compactação, interações e subagentes |
| [04-capabilities-tools-and-provider-gateway.md](./04-capabilities-tools-and-provider-gateway.md) | Catálogo, policy, tools nativas/delegadas, providers e `code_exec` |
| [05-durability-events-and-observability.md](./05-durability-events-and-observability.md) | Checkpoints, spool, journal, replay, métricas, privacidade e recovery |
| [06-rollout-gates-and-retirement.md](./06-rollout-gates-and-retirement.md) | Fases, benchmarks, canário, rollback e retirada do legado |
| [07-risks-and-failure-modes.md](./07-risks-and-failure-modes.md) | Registro de riscos e respostas obrigatórias |
| [08-surface-migration-and-post-cutover-cleanup.md](./08-surface-migration-and-post-cutover-cleanup.md) | Migração por superfície, compatibilidade, drain e limpeza pós-cutover |
| [09-native-indexer-and-docs-rag.md](./09-native-indexer-and-docs-rag.md) | Indexador nativo (`indexd`): código, embeddings locais e RAG de documentos |
| [IMPLEMENTATION-CHECKLIST.md](./IMPLEMENTATION-CHECKLIST.md) | Controle de execução e definição de conclusão |

## 5. Ordem de precedência

Em caso de conflito:

1. requisitos MUST deste corpus;
2. o `.proto` versionado e seus testes de compatibilidade;
3. `packages/agent-runtime-contracts` enquanto modelo semântico;
4. contratos persistidos do control plane e migrations;
5. comportamento observado do runtime legado;
6. documentação histórica.

`packages/agent-runtime-contracts` é semente semântica, não wire format. Tipos
como `unknown`, `object`, unions TypeScript, `number`, timestamps em string e
floats monetários precisam de representação explícita no IDL.

## 6. Relação com a arquitetura existente

Este corpus preserva as decisões maduras de:

- command ledger e idempotência;
- `AgentRun`, attempt, lease e fencing;
- journal canônico e projeções;
- Policy Engine como autoridade;
- tiers como visibilidade, não autorização;
- `WorkspaceLease` e resource binding;
- `outcome_unknown` para mutação sem ACK;
- memória em camadas;
- foreground/background como o mesmo modelo de run.

Para o novo runtime, ele substitui as decisões históricas que preservavam o BT
runner TypeScript e que vinculavam ownership do subagente ao worker do pai. O
legado continua inalterado até o cutover, mas não é a arquitetura-alvo.

Referências semânticas existentes:

- `packages/agent-runtime-contracts/src/commands.ts`
- `packages/agent-runtime-contracts/src/runs.ts`
- `packages/agent-runtime-contracts/src/events.ts`
- `packages/agent-runtime-contracts/src/capabilities.ts`
- `packages/agent-runtime-contracts/src/policy.ts`
- `docs/research/claudeopen-convergence/14-target-control-plane-contracts.md`
- `docs/research/claudeopen-convergence/19-runtime-hardening-corrections.md`

## 7. Layout-alvo do código

O primeiro PR de scaffold DEVE validar ou alterar este layout por ADR:

```text
native/agent-runtime/
  Cargo.toml
  crates/
    agentd-supervisor/
    agent-runner/
    agent-protocol/
    agent-engine/
    agent-tools/
    agent-spool/
    agent-session-bridge/
    agent-session-store/
    agent-platform/

native/index-runtime/
  Cargo.toml
  crates/
    indexd/
    index-core/
    index-embed/
    index-protocol/

packages/agent-runtime-contracts/
  proto/codestudio/agent/v1/
  proto/codestudio/index/v1/
  src/generated/v1/
  src/adapters/

packages/agent-runtime-host/
  src/facade/
  src/router/
  src/adapters/
  src/provider-gateway/
  src/tool-host/
  src/projectors/

packages/agent-prompts/
  src/
  assets/
```

Regras:

- `proto/codestudio/agent/v1` é a única fonte cross-language.
- Rust e TypeScript gerados não são editados manualmente.
- adapters traduzem domínio local para tipos de wire.
- entry points de produto dependem de `agent-runtime-host`, não do runner.
- prompts e assets compartilhados não pertencem ao package legado.
- supervisor não depende de provider, plugin, storage de sessão, SQLite ou UI.
- `agent-session-store` não depende de engine, runner, provider ou UI.
- `agent-session-bridge` depende somente de protocolo/store, recebe roots apenas
  no bootstrap Rust e nunca aceita path ou extension fornecido por TypeScript.
- runners nunca recebem paths de bundle; commits passam por ports/IDL.
- engine não importa bindings de Windows/Linux/macOS diretamente.
- enforcement de plataforma pertence a `agent-platform`.

## 8. Programa de implementação

```mermaid
flowchart LR
    A["Spec e baseline"] --> B["IDL e supervisor"]
    B --> C["Runner mínimo e provider host"]
    C --> D["Tools nativas e policy"]
    D --> E["Session store, subagentes, checkpoint e spool"]
    E --> F["Shadow e chaos"]
    F --> G["Canário"]
    G --> H["Default Rust"]
    H --> I["Retirada do legado"]
```

Não existe fase destinada a consertar o runtime TypeScript atual. Mudança no
legado só entra neste programa quando for estritamente necessária para:

- expor uma fronteira usada pelo novo runtime;
- permitir shadow/comparação/fallback;
- impedir corrupção, bypass de segurança ou perda de dados durante o rollout.

Qualquer outra alteração no legado é trabalho separado.

## 9. Definição global de conclusão

O programa só termina quando:

- todos os MUST deste corpus estiverem rastreados;
- todos os gates da Fase 7 estiverem aprovados;
- nenhuma sessão nova depender do worker V8;
- rollback para a última versão Rust estável funcionar sem reativar execução
  duplicada;
- processos, Jobs/resource groups, pipes e spools forem liberados após cada
  tentativa;
- bundles `rust_fs_v1`, journal, métricas, artifacts e checkpoints possuírem
  writer Rust único, recovery e quotas comprovados;
- compatibilidade de provider, tools, approvals, subagentes, Company Mode,
  plugins, MCP, memória e `code_exec` estiver comprovada;
- o runtime legado puder ser removido sem manter dual-write ou dual-execution;
- todas as superfícies A01–A20 tiverem passado pela fachada e pelo gate próprio;
- o grafo externo de `packages/code-agent` estiver zerado e a build instalada
  não contiver executor, worker ou launcher legado;
- histórico e dados de produto permanecerem legíveis, com bridges/schema
  classificados para contração separada e segura.
