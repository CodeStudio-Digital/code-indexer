# Rust Agent Runtime — especificação normativa

> **Status:** especificação final para implementação  
> **Versão:** 1.36.0
> **Data-base:** 2026-08-05
> **Autoridade:** este diretório governa o novo runtime de agentes em Rust  
> **Checklist executiva:** [IMPLEMENTATION-CHECKLIST.md](./IMPLEMENTATION-CHECKLIST.md)

> **Estado verificado em 2026-10-05:** o produto ainda usa `legacy_required`.
> Componentes Rust e integrações físicas passaram por testes, mas a entrada
> normal da interface ainda não usa essa composição. O pacote Windows validado
> também executou o legado. Consulte o
> [plano atualizado, entregas e estimativas](./IMPLEMENTATION-CHECKLIST.md#plano-de-execução-atualizado--2026-10-05)
> e as [medições do candidato](./10-harness-performance-2026-10-03.md#candidato-validado-em-2026-10-05-produto-interface-e-continuidade-nativa).
> As descrições abaixo preservam o histórico técnico de 2026-08-05, incluindo
> números e limitações que já mudaram; não são o status atual do produto.

> **Snapshot operacional histórico (2026-08-05):** o E2E físico Windows já comprova a lifecycle inteira
> `Host TS → supervisor → agent-runner → AgentHello → hidratação → Prepared →
> Activate/ACK → Active`, com `RunnerPulse`, heartbeat, métricas reais do
> processo, Cancel/Fence, fatos `Exited/Reaped` duráveis e reap do runner sem
> derrubar o supervisor. Control, Data e management possuem owners permanentes e
> deadlines independentes; o término de um stream não fecha implicitamente o
> irmão. O runner permanece em idle bounded depois do turno e o Host retém Data
> até a coordenação terminal Control. No Windows, EOF/pipe encerrado esperado é
> normalizado e uma janela terminal limitada permite que o ACK já escrito seja
> consumido antes do cleanup. Nenhum pulse ou heartbeat renova hard deadline.
>
> O primeiro turno produtivo também atravessa agora o processo e o Named Pipe
> reais. Depois de `Active`, o `agent-engine` consome o `ProviderGatewayPort`, o
> runner envia `ProviderStart`, o Gateway TS resolve/executa o provider e devolve
> `ProviderAccepted`, texto, usage e terminal tipados. O start só é publicado
> depois do write físico; Accepted é correlacionado ao message-id, digest,
> operation, runtime instance e clock. Host e runner usam a mesma authority de
> clock no adapter e toleram somente 50 ms de inversão entre peers locais; o
> limite superior do Host continua estrito. EOF não vira sucesso, tool arguments
> são verificados por SHA-256 e somente terminal libera a operação.
>
> A durabilidade do turno não cria dependência de storage no engine nem no core
> `agent-host-bridge`. O runner implementa `EventSinkPort`, codifica
> `EngineEventRecordV1` e envia `EngineEventProposal` no Data. O Host valida
> identity/runtime/digest/durability, pede o commit ao writer filesystem Rust
> fenced através do `agent-session-bridge` e só então responde
> `EngineEventCommitted` com o receipt hash-chained. Sequência e terminal avançam
> apenas após esse receipt. O E2E produtivo com tool confirma nove records
> consecutivos, do primeiro provider-started ao terminal autoritativo do segundo
> turn, no `conversation.jsonl` nativo.
>
> A composição inicial continua tipada, redigida e single-owner: agent
> definition, capability set, provider preset e task hidratada só ficam
> executáveis após authority `Active`. A fatia 1.34 implementa a primeira rota
> nativa aceita: `native.read_file` recebe binding filesystem selado, revalida
> grant/expiry/authority imediatamente antes do efeito, prova pelo handle final
> do Windows que o arquivo continua dentro da raiz, aplica quotas e UTF-8, e
> atravessa records autoritativos distintos de `started` e `terminal`. O
> resultado bounded volta ao composer com pairing por `toolUseId`; o cursor
> `response_id/message_count` é preservado e o engine abre o próximo provider
> turn no mesmo Data owner. Os bytes do contexto entre turns usam `Arc<[u8]>`,
> sem clone integral permanente. Uma prova duplex cross-crate cobre a sequência
> completa com sete receipts. O Host agora possui uma policy de produto
> fail-closed: ela confere o digest do catálogo hidratado, canonicaliza a raiz
> confiável do workspace fora do input do modelo e sela environment,
> lease/fencing, quotas, policy, nonce e expiry. O E2E process-real comprova o
> grant, a leitura por handle final, nove commits físicos e o retorno exato ao
> segundo provider turn. Isso ainda não torna a tool default nas superfícies do
> produto: routing/canário continuam abertos. Resume de attempt por checkpoint,
> fallback/recovery,
> recovery de started órfão/probe, outras tools, outbox recovery, métricas agregadas,
> `UpdateAttemptAuthority`, soak/chaos/canário e matriz multiplataforma seguem
> abertos.
>
> A fatia 1.35 fecha a ambiguidade live do executor depois de `started`: erro de
> runtime/transport vira `outcome_unknown`, recebe terminal autoritativo, chega
> ao provider como `tool_result` de erro e nunca causa retry interno. Crash/EOF
> que impeça o próprio commit terminal ainda exige reconciliação pelo journal e
> permanece aberto.
>
> A fatia 1.36 acrescenta o inventário de recovery sem leitura direta de paths:
> o session store pagina no máximo 256 receipts por vez e revalida a cadeia
> inteira; o bridge autenticado expõe apenas metadata; o Host lê payloads pelo
> receipt exato e encontra `started` sem terminal. Scan truncado, terminal
> divergente, hash ou bytes incompatíveis falham fechado. Persistir a decisão de
> recovery/probe em nova attempt continua aberto.
>
> A fatia 1.36 foi revalidada com format, Clippy estrito e todos os testes do
> workspace Rust; 51 testes de contratos TS/Rust, typecheck e 355 testes Host;
> orçamento de LOC (755 módulos produtivos, máximo 250); grafo de 11 crates/14
> arestas; e a suíte física completa de 5 cenários. O pacote Windows candidato
> `runtime-v1-f6496fb120c29da50913e04eba033f98b67f85468e85035e34fe5aba6ba39930`
> (manifest
> `807b861d2d7093c58af749ef74566fefa5b4389cbc1268acc2f9e336a740fd6e`)
> passou verify e smoke de addon/runner/supervisor. O gate global de fronteira
> legado permanece vermelho por drift externo já existente; a baseline não foi
> ratcheted nesta fatia e nenhum módulo legado foi alterado para ocultá-lo.

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
    agent-host-bridge/
    agent-host-bridge-napi/
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
