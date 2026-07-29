# Registro vinculante de decisões

> **Status:** aceito para implementação  
> **Detalhamento:** [00-scope-decisions.md](./00-scope-decisions.md)

Alterar uma decisão abaixo exige ADR no mesmo diretório, atualização da
checklist e reexecução dos gates afetados.

| ID | Status | Decisão |
|---|---|---|
| D-RUST-001 | Aceita | Rust é o runtime de agentes e tools nativas |
| D-RUST-002 | Aceita | Um processo single-tenant por `AgentRunAttempt` |
| D-RUST-003 | Aceita | Supervisor persistente não mantém estado de agente |
| D-RUST-004 | Aceita | Attempt, owner e fencing definem authority física |
| D-RUST-005 | Aceita | Attempts isolam; run-tree possui orçamento agregado |
| D-RUST-006 | Aceita | TypeScript continua control/integration plane |
| D-RUST-007 | Supersedida em parte | SQLite não é session store; ownership dos bundles foi substituído por D-RUST-029 |
| D-RUST-008 | Aceita | Provider Gateway permanece TypeScript na V1 |
| D-RUST-009 | Aceita | `code_exec` executa em subprocesso descartável |
| D-RUST-010 | Aceita | `.proto` gerado é a única autoridade cross-language |
| D-RUST-011 | Aceita | Terminal só existe após barreira durável |
| D-RUST-012 | Aceita | Legado é oracle/fallback temporário, não alvo de remendos |
| D-RUST-013 | Aceita | Migração usa fachada neutra e roteamento durável por attempt |
| D-RUST-014 | Aceita | Dependências compartilhadas saem antes; legado termina como folha |
| D-RUST-015 | Aceita | Retirada de código é separada da contração segura de dados |
| D-RUST-016 | Aceita | Windows cria runner e descendants atomicamente no Job via `PROC_THREAD_ATTRIBUTE_JOB_LIST`; attach pós-criação não é fallback |
| D-RUST-017 | Aceita | Estado de lifecycle e `ActiveAuthority` só são publicados após receipt não-forjável do commit do frame correspondente |
| D-RUST-018 | Aceita | Efeitos entram por guard de dispatch no mesmo gate de revogação; check booleano desacoplado é proibido |
| D-RUST-019 | Aceita | Header, relógio e sequência de saída pertencem a uma autoridade única por direção; handlers fornecem somente payload |
| D-RUST-020 | Aceita | Replay e caches são limitados simultaneamente por entradas e bytes físicos, com buffers imutáveis compartilhados |
| D-RUST-021 | Aceita | Toda operação pendente possui abort e reaper por deadline; perder token nunca fixa processo ou heap |
| D-RUST-022 | Aceita | API pública de efeito só abre com broker que registra handle atomicamente e cancela fila e in-flight na revogação |
| D-RUST-023 | Aceita | Connection ID nasce com o endpoint antes do spawn e fica selado no launch, nos dois Hello e no handoff |
| D-RUST-024 | Aceita | Handshake só avança pela fachada que possui sessão, transporte e sender; transições cruas não são públicas |
| D-RUST-025 | Aceita | Endpoint local é single-owner e verifica peer físico; bootstrap Windows usa dois pares privados overlapped/síncronos e listeners nascem no runner contido; Unix transfere socket bindado e escuta no runner; supervisor não retransmite frames |
| D-RUST-026 | Aceita | Bootstrap supervisor→runner possui IDL/caps e transição single-use próprios; tokens viram hashes, launch nonce vive em owner zeroizing até `AgentHello`, activation nonce fica no host e cruza apenas como seal, e validação de forma/wire não substitui prova física |
| D-RUST-027 | Aceita | O adapter Host produtivo é um bridge Rust in-process que cria um owner opaco, verifica PID/UID no mesmo HANDLE/FD e transfere transporte ou cleanup atomicamente; PID informado por JS, probe+reopen e relay pelo supervisor são proibidos |
| D-RUST-028 | Aceita | Shutdown é transacional e monotônico: Drain preserva schedules sob ceiling global; TerminateAfterGrace agenda owners por mínimo e pode escalar Drain, nunca ser enfraquecido |
| D-RUST-029 | Aceita | `agent-session-store` Rust é o writer físico único dos bundles `rust_fs_v1`; Host TS mantém authority semântica e nunca faz dual-write |
| D-RUST-030 | Aceita | `agent-host-bridge` é o núcleo safe do owner Host; `agent-host-bridge-napi` é seu wrapper Node-API 8 fino e in-process, recebe um request Protobuf único ligado aos fatos duráveis, mantém Control/Data em um owner Rust cancelável e não revalida nem expõe path/token/HANDLE em JavaScript |

## Trilho do indexador (doc 09)

| ID | Status | Decisão |
|---|---|---|
| D-IDX-001 | Aceita | `indexd` é daemon Rust próprio, separado do agentd |
| D-IDX-002 | Aceita | Indexação é multi-tenant reciclável — estado é derivado, ao contrário de attempts |
| D-IDX-003 | Aceita | `indexd` é o escritor único do `index.db` por projeto após I2 |
| D-IDX-004 | Aceita | Leitura lexical/estrutural direta read-only; via semântica por RPC |
| D-IDX-005 | Aceita | bge-m3 e cross-encoder locais rodam no `indexd` via ONNX Runtime |
| D-IDX-006 | Aceita | Watch/walk nativos; watch budget rebaixado a telemetria |
| D-IDX-007 | Aceita | RAG docs: compute no `indexd`; captação, política e persistência no host |
| D-IDX-008 | Aceita | Protobuf `codestudio/index/v1`; jobs idempotentes por content-hash + generation |
| D-IDX-009 | Aceita | Walker/hasher é o piloto de toolchain/signing/packaging da cadeia nativa |
| D-IDX-010 | Aceita | Paridade medida (golden/nDCG/eval-metrics) antes de qualquer otimização |

## Decisões históricas afetadas

| Decisão histórica | Novo entendimento |
|---|---|
| D-002 — convergência híbrida | Preserva capacidades e contratos, não o motor TypeScript |
| D-006 — preservar BT runner | Restrita ao runtime legado; supersedida no Rust |
| D-016 — composition root shadow | Continua como adapter legado, não composição do Rust |
| D-019 — child owner é worker pai | Válida só no legado; no Rust o executor físico é o owner |
| 14 §24 — não reescrever `CoderRunner` | Não se aplica ao novo programa |

## Decisões que permanecem

Continuam vinculantes as decisões históricas sobre:

- journal canônico e projeções;
- Ultra como preset ortogonal;
- tiers como visibilidade;
- Policy Engine único;
- foreground/background compartilhando `AgentRun`;
- memória em camadas;
- eficácia condicionada a benchmark;
- `waitMode` como snapshot;
- um root `AgentRun` por command e filhos hierárquicos.

## Como registrar mudança

Um ADR novo DEVE conter:

1. contexto e evidência;
2. decisão anterior;
3. decisão nova;
4. alternativas;
5. impacto em protocolo, persistência e rollout;
6. riscos e rollback;
7. requisitos/checks afetados;
8. aprovação e data.
