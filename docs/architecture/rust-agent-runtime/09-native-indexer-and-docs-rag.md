# 09 — Indexador nativo e RAG de documentos

> **Status:** normativo  
> **Depende de:** 00 (escopo), 02 (IDL/transporte), 06 (gates e rollout)  
> **Bloqueia:** todo código Rust do indexador (`indexd`)

## 1. Problema

Toda a indexação do produto executa dentro do processo Electron e do runtime
Node:

- o pipeline de índice de código roda em worker_threads
  (`packages/indexer/src/workers/pool.ts`, `workers/indexJob/worker.ts`) com
  política de respawn por saúde (`workers/respawn-policy.ts`) — o processo como
  backstop já é admitido, mas o RSS é o mesmo do app;
- o watcher do host observa o filesystem com watch budget como limite de
  correção (caso Unity 68k arquivos), e reconcile/scan competem com a UI;
- a inferência local (bge-m3 e cross-encoder) vive no Node com gestão manual de
  lifecycle ONNX (`search/onnx-idle.ts`, `search/local-embeddings.ts`,
  `search/local-reranker.ts`) — a RAM nativa só volta com o idle-dispose;
- a ingestão de RAG docs replica o padrão: pool de extraction-workers no
  processo do app (`packages/services/src/services/docs/index-doc-use-case/
  extraction-pool.ts`), chunking, PDF e embed-upsert em Node.

O trilho `indexd` DEVE remover indexação e inferência local do processo do app,
com qualidade de busca igual ou melhor, medida — nunca presumida.

## 2. Objetivos

### SCOPE-IDX-001 — Runtime de indexação independente

Construir um daemon Rust (`indexd`) que execute walk/watch, hashing, extração
estrutural, embeddings locais e rerank local sem carregar Node.

### SCOPE-IDX-002 — Processo do app livre de indexação

Após o cutover de cada camada, o Electron main NÃO DEVE executar walk, parse,
chunking ou inferência local da camada migrada.

### SCOPE-IDX-003 — Qualidade gated por benchmark

Paridade é medida pelo harness de código
(`packages/indexer/src/benchmarks/engine.ts`, nDCG) e pelas eval-metrics de
docs (`packages/services/src/services/docs/eval-metrics.ts`). Regressão bloqueia
promoção.

### SCOPE-IDX-004 — RAG docs no mesmo trilho

A parte computacional da ingestão de documentos (extração, chunking, PDF,
embed) pertence ao `indexd`. Captação de rede/browser e política permanecem no
host.

### SCOPE-IDX-005 — Piloto da cadeia nativa

O primeiro binário do `indexd` é o piloto de toolchain, signing, packaging e
cohort (SCOPE-007..012) antes de o canário do agent runtime depender deles.

## 3. Não objetivos

- Portar planner, fusão híbrida, HyDE, políticas de rerank e semantic profiles
  (`search/hybrid-pipeline.ts`, `planner.ts`, `hyde.ts`,
  `local-reranker-policy.ts`, `semantic-profile-runtime.ts`) — permanecem TS.
- Portar crawler, url-fetcher, render-backend, bot-detection, sitemap,
  auto-discovery e relevance-gate — rede, browser e política são control plane.
- Trocar modelos (bge-m3, cross-encoder atual) ou o contrato dos consumidores
  (tools `mcp__*`, completion, outline/rename, docs-agent, aba de docs).
- Mover as tabelas `doc_*` para fora do store na V1.
- Substituir embed/rerank via provider (rede) — continuam no host.
- Corrigir o pipeline Node atual como estratégia final (espelha D-RUST-012).

## 4. Terminologia

| Termo | Definição |
|---|---|
| indexd | Daemon Rust de indexação, separado do agentd |
| IndexScope | Unidade de isolamento lógico: projeto (código) ou collection (docs) |
| IndexJob | Trabalho idempotente de walk, extração, embed ou ingest |
| Generation | Época de (re)indexação; vetores e chunks são pinados a ela |
| Golden extract | Snapshot aprovado da extração estrutural de um corpus fixo |
| Harness | Benchmark nDCG de código + eval-metrics de docs, executados pelo host |

## 5. Decisões de arquitetura

### D-IDX-001 — `indexd` é um daemon próprio, não parte do agentd

- **Escolha:** binário e workspace próprios (`native/index-runtime`), fault
  domain separado do supervisor/runners de agente.
- **Motivo:** perfis opostos (indexação é bursty e reconstruível; attempts são
  interativas e não-reconstruíveis); crash ou recycle de indexação NÃO DEVE
  afetar nenhuma attempt.
- **Consequência:** compartilhamento com o agent runtime ocorre por convenção e
  IDL, não por linkagem; crates comuns só por ADR.

### D-IDX-002 — Multi-tenant reciclável, ao contrário de D-RUST-002

Attempts exigem processo single-tenant porque seu estado é irrecuperável. O
índice é derivado: perda total custa um re-scan. Portanto o `indexd` PODE
hospedar múltiplos IndexScopes em um processo, DEVE suportar recycle a qualquer
momento sem corromper estado (jobs idempotentes + generations) e DEVERIA
reciclar-se após scans grandes ou por threshold de RSS. Scans pesados PODEM ser
delegados a subprocesso no resource group do `indexd`.

### D-IDX-003 — `indexd` é o escritor único do índice de código por projeto

- O `index.db` por projeto (`.mcp-indexer/`) NÃO é o SQLite central nem bundle
  de sessão; D-RUST-007/D-RUST-029 não se aplicam a ele.
- Após o cutover da camada estrutural, o `indexd` torna-se o único processo
  escritor; host e consumidores leem read-only via WAL.
- Migrações de schema do `index.db` e o versionamento de extração
  (`EXTRACTOR_VERSION`, content-hash de `indexer/content-hash.ts`) passam a ser
  propriedade do `indexd`, com o mesmo rigor version-gated do store.
- Transição por projeto atrás de flag; um lock de escritor DEVE impedir escrita
  dupla durante a troca.

### D-IDX-004 — Consulta: leitura direta para o barato, RPC para o semântico

Leituras lexicais/estruturais continuam SQL read-only feitas pelo TS. A via
semântica (vetores, LSH/ANN, similaridade) é servida pelo `indexd` via RPC,
substituindo `search/lsh-index.ts` e `lsh-indexing-sink.ts`. O planner TS
compõe as fontes como hoje.

### D-IDX-005 — Inferência local via ONNX Runtime no `indexd`

Embeddings bge-m3 e cross-encoder rodam no `indexd` (crate `ort`), com os
MESMOS modelos e tokenizers dos pipelines atuais. O host provisiona e verifica
os arquivos de modelo; o `indexd` os consome read-only. Ociosidade descarrega a
sessão ou recicla o processo — `onnx-idle` deixa de existir em Node. Embed e
rerank por provider (rede) permanecem no host (Provider Gateway).

### D-IDX-006 — Watch e walk nativos

`notify` + `ignore`/`globset` com reconcile por content-hash substituem o
watcher do host para fins de indexação. O watch budget deixa de ser mecanismo
de correção e vira telemetria. O main process NÃO DEVE observar filesystem para
indexação após I1.

### D-IDX-007 — RAG docs: compute no `indexd`, captação e política no host

Migram para o `indexd`: HTML→Markdown, section-chunker, chunk-packer,
pdf-parser, attachment-extract, enricher/api-signature e o embed em lote
(substituindo `extraction-pool.ts`/`extraction-worker.ts` e o caminho de
`embed-upsert.ts`). Permanecem no host: crawler, url-fetcher, render-backend,
bot-detection, relevance-gate/policy e a orquestração
(`index-doc-use-case/run-ingest.ts`). O host entrega bytes brutos por
spool/handle; o `indexd` devolve chunks + vetores prontos. Na V1 o host
persiste `doc_*` no store (escritor único preservado); storage próprio de docs
no `indexd` só por ADR posterior.

### D-IDX-008 — Protocolo e idempotência

Mesmo mecanismo do 02: protobuf gerado, Named Pipe/Unix socket, namespace
`codestudio/index/v1`. Todo IndexJob carrega scope, generation, content-hash e
deadline; reexecução é no-op por construção (alinha com
`doc_ingest_generations`, mig 214, e o pin de geração de embeddings). Filas são
bounded; payload grande vai por spool/handle, nunca inline.

### D-IDX-009 — O walker é o piloto da cadeia nativa

O primeiro entregável é o binário mínimo (walk + hash + reconcile) empacotado,
assinado e distribuído pelo pipeline do Electron com flag de cohort. Ele existe
para validar SCOPE-007..012 com falha barata antes do canário do agentd —
qualquer gap de packaging encontrado aqui é corrigido aqui.

### D-IDX-010 — Paridade antes de otimização

Cada camada migrada DEVE primeiro produzir os mesmos registros/resultados que o
pipeline Node (golden extracts, paridade de conjunto de arquivos, drift coseno
em corpus dourado, nDCG/eval-metrics estáveis). Só depois de aprovada a
paridade o formato interno pode evoluir, sob nova generation.

## 6. Camadas e destino

| Componente hoje | Path | Destino |
|---|---|---|
| Walk/scan + ignore + hash | `indexer/scanner-ignore.ts`, `content-hash.ts`, `incremental.ts` | `indexd` (I0/I1) |
| Watcher de indexação | watcher do host + watch budget | `indexd` (I1) |
| Extração estrutural | `indexer/tree-sitter/*`, `structural-incremental.ts` | `indexd` (I2) |
| Sessões/turnos | `session-storage/FileSessionRepository` | `agent-session-store` após transfer `rust_fs_v1`; fachada TS sem escrita física |
| Embeddings locais | `search/local-embeddings.ts`, `embed-parallel.ts`, `embed-executor.ts` | `indexd` (I3) |
| Rerank local + LSH | `search/local-reranker.ts`, `lsh-index.ts` | `indexd` (I3) |
| Docs: extração/chunk/PDF/embed | `services/docs/*` (compute) | `indexd` (I4) |
| Docs: crawler/render/política | `services/docs/*` (rede/browser) | host (fica) |
| Planner/híbrido/HyDE/policies | `search/*` | host (fica) |
| Benchmarks e eval-metrics | `benchmarks/*`, `docs/eval-metrics.ts` | host (oracle e juiz) |
| Consumidores do índice | mcp-server, completion, outline/rename, docs-agent | host (inalterados) |

## 7. Ownership

| Recurso | Owner | Observação |
|---|---|---|
| `index.db` por projeto | `indexd` após I2 | Escritor único; TS read-only WAL |
| SQLite central e tabelas `doc_*` | Host | Fora do session runtime; Rust não abre (D-RUST-007) |
| Modelos ONNX e tokenizers | Host provisiona; `indexd` consome | Verificação de hash na carga |
| Vetores/ANN de código | `indexd` | Servidos por RPC |
| Generations e invalidação | `indexd` | Pinadas em todo vetor/chunk |
| Crawling, robots, browser | Host | Política e rede são control plane |
| Harness de qualidade | Host | Gate de toda promoção |

## 8. Invariantes

1. Após o cutover de uma camada, nenhum walk/parse/chunk/inferência daquela
   camada executa no processo Electron.
2. O `index.db` de um projeto tem no máximo um processo escritor em qualquer
   instante, garantido por lock — inclusive durante a transição.
3. Queda do `indexd` degrada para leitura stale + grep; nunca bloqueia UI,
   agentes ou a aba de docs.
4. Todo IndexJob é idempotente por content-hash + generation.
5. Vetores de generations ou geradores distintos nunca se misturam no mesmo
   espaço de busca.
6. Recycle do `indexd` é operação normal e sem perda, não incidente.
7. Nenhuma fila host⇄indexd é ilimitada; resultado grande vai por spool/handle.
8. Regressão no harness bloqueia promoção; não existe exceção manual sem ADR.

## 9. Programa

| Fase | Entrega | Gate |
|---|---|---|
| I0 | Walker/hasher empacotado e assinado (piloto da cadeia) | `IDX-GATE-0` |
| I1 | Watch nativo + reconcile contínuo | `IDX-GATE-1` |
| I2 | Extração tree-sitter + escritor único do index.db | `IDX-GATE-2` |
| I3 | Embeddings + rerank local + ANN via RPC | `IDX-GATE-3` |
| I4 | Compute de RAG docs no `indexd` | `IDX-GATE-4` |

- `IDX-GATE-0`: paridade de conjunto de arquivos com o scanner atual em três
  repositórios reais (incluindo o caso Assets/68k); packaging/signing/cohort
  validados; CPU de walk fora do main comprovada.
- `IDX-GATE-1`: eventos de mudança equivalentes aos do watcher atual sem
  re-scan storm; watch budget rebaixado a telemetria.
- `IDX-GATE-2`: golden extracts idênticos por linguagem suportada; outline,
  rename e skeleton dos consumidores inalterados; `EXTRACTOR_VERSION` sob
  propriedade do `indexd`; nDCG estável.
- `IDX-GATE-3`: nDCG ≥ baseline no harness; drift coseno dentro do limiar no
  corpus dourado; RSS do Electron sem termo de ONNX; re-embed completo por
  generation comprovado.
- `IDX-GATE-4`: eval-metrics de docs iguais ou melhores; ingestão sem
  extraction-pool Node; tempo de ingestão igual ou menor.

Sequenciamento com o agent runtime: I0 DEVE preceder o canário G6 do agentd
(piloto de packaging). I2..I4 NÃO DEVEM iniciar antes de o canário do agentd
estar em soak, salvo ADR — um trilho nativo instável de cada vez.

## 10. Riscos específicos

| Risco | Resposta obrigatória |
|---|---|
| Escrita dupla no index.db na transição | Lock de escritor + flag por projeto + teste de contenção |
| Drift de gramática tree-sitter (versões Node × Rust) | Pinagem de versão por gramática + golden extracts por linguagem |
| Drift de tokenizer/embedding entre runtimes | Corpus dourado com limiar de coseno; re-embed por generation, nunca mistura |
| WAL contention em leitura TS | busy_timeout + leitura snapshot; benchmark de latência de consulta |
| Antivírus/locks no Windows durante walk | Retry com backoff + telemetria de arquivos pulados (sem silêncio) |
| Crescimento de ANN em RAM | Estruturas mmap/em disco + recycle por threshold |
| Modelo ONNX ausente/corrompido | Verificação de hash na carga; degradar para lexical com evento visível |

## 11. Gate deste documento

Antes de código funcional do `indexd`:

- decisões D-IDX-001..010 aceitas e registradas em `DECISIONS.md`;
- layout `native/index-runtime` validado ou alterado por ADR;
- namespace `codestudio/index/v1` refletido no IDL;
- baseline do harness (nDCG, eval-metrics, golden extracts) congelada em build
  empacotada, três execuções, dispersão registrada;
- ownership de index.db, modelos, generations e `doc_*` com exatamente um owner.
