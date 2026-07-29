# ADR-001 — Rust como authority física do storage de sessão

> **Status:** aceito  
> **Data:** 2026-07-28  
> **Decisão vinculante:** `D-RUST-029`  
> **Supersede:** a parte de `D-RUST-007` que atribuía bundles ao Host TypeScript

## 1. Contexto e evidência

A retirada do estado operacional de sessão do SQLite e sua migração para
bundles filesystem eliminou o travamento observado no caminho de sessão. Isso
separa duas questões:

- SQLite continua inadequado para transcript, eventos, métricas e artifacts de
  sessão;
- manter a lógica física do bundle em TypeScript prolongaria dois runtimes de
  lifecycle, recovery, quotas e retenção depois do cutover do agente.

O runtime Rust já tem como objetivo ownership explícito, limites físicos,
recovery determinístico e estado grande fora do heap. A mesma fronteira deve
governar os commits operacionais que permitem retomar uma sessão.

## 2. Decisão anterior

`D-RUST-007` dizia que o Host TypeScript era o único writer do SQLite central e
dos bundles filesystem. Rust recebia snapshots e enviava proposals, mas nunca
abria o storage de sessão.

Essa decisão reduzia o escopo inicial, porém deixava journal, checkpoints,
metric rollups, recovery e terminal barrier implementados no runtime que será
retirado.

## 3. Nova decisão

O target possui um crate Rust `agent-session-store`, composto por um bridge
nativo autenticado e independente de `agentd-supervisor` e dos runners.

- SQLite nunca contém runtime de sessão. Stores SQLite não relacionados
  continuam com seus owners atuais e Rust não recebe credenciais de DB.
- O Rust session store é o único writer físico de bundles `rust_fs_v1`.
- O Host TypeScript continua authority semântica de command, policy, provider,
  produto e UI, mas solicita commits e recebe receipts tipados.
- Supervisor e runner não abrem bundles. Eles produzem fatos/records bounded
  que chegam ao writer por uma fachada neutra.
- O writer atribui `globalSeq`, encadeia hashes, confirma artifact/checkpoint,
  publica projeções e metric rollups e executa recovery/GC.
- Uma sessão possui a geração de storage no manifesto imutável e transições de
  lease epoch/writer no `storage-authority.jsonl` append-only e hash-chained.
  A troca `typescript_fs_v1 → rust_fs_v1` exige drain e é irreversível na
  mesma versão do bundle.
- Não existe dual-write, fallback para SQLite ou dois writers concorrentes.

O IDL deve ganhar `session_store.proto` com, no mínimo:

```text
OpenSessionWriter
CommitSessionRecord
CommitSessionRecordReceipt
ReadCommittedSessionPayload
PublishSessionProjection
QuerySessionState
TransferSessionStorageGeneration
ArchiveSession
```

O receipt liga `session_id`, storage generation, lease epoch, operation ID,
global sequence, previous/current hash e durability class. O Host só publica
ACK/terminal depois desse receipt.

A leitura de bytes comprometidos exige o `writer_handle`, a authority física
corrente e o receipt exato por `operation_id + kind + SHA-256 + byte_length`.
Hash de conteúdo isolado nunca é capability. O bridge entrega bytes bounded,
sem serializar root ou path do bundle para Host, supervisor ou runner.

## 4. Layout e limites

O layout existente permanece compatível. `conversation.jsonl` continua
canônico; payloads grandes são refs content-addressed. `metrics/` armazena
rollups/segmentos bounded, não uma série ilimitada por attempt.

Todo writer nasce com limites explícitos de:

- records e bytes de payload;
- journal/segment;
- artifacts, checkpoints e spool;
- fila/in-flight;
- arquivos abertos e sessões simultâneas;
- retenção, rotação e GC.

Secret, credential, token, handle, path privado absoluto e environment bruto
continuam proibidos em bundle, journal, métricas e diagnostics.

### 4.1 Protocolo físico de transferência

A transferência de um bundle `typescript_fs_v1` usa a seguinte ordem
vinculante:

1. O Host fecha a admission, drena a fila do writer TypeScript e obtém o
   `leaseEpoch` persistido em `events/writer.fence.json`.
2. O verificador Rust calcula um inventário bounded de todos os arquivos
   regulares do bundle, exceto o lease transitório `events/writer.lease`.
   Symlink, junction/reparse point, arquivo especial, identidade de sessão
   divergente, arquivo obrigatório ausente ou quota excedida falham fechado.
3. O transferidor serializa a operação por lock físico no root e cria com
   `create_new` um lease de transferência no formato já respeitado pelo writer
   TypeScript. Lease preexistente que não seja byte a byte o guard da mesma
   transação prova dual-writer e bloqueia o corte.
4. Sob esse guard, Rust recalcula o inventário e exige igualdade com
   `verified_manifest_sha256`. O hash agregado usa o domínio
   `codestudio.agent.typescript-fs-v1.inventory.v1\0` e, em ordem lexical,
   `pathLength || path UTF-8 normalizado com "/" || fileBytes || fileSha256`.
5. Um bundle `rust_fs_v1` completo nasce em staging irmão no mesmo root. O
   bundle original inteiro é copiado e verificado em
   `legacy/typescript_fs_v1/`; o journal Rust recebe um checkpoint
   authoritative content-addressed que referencia esse snapshot. Assim o
   journal novo permanece canônico e nenhum byte histórico é reinterpretado ou
   descartado durante o corte.
6. Rust persiste o manifest integral e o activation receipt no staging,
   reinspeciona origem e cópia, renomeia a origem para backup de recovery e
   renomeia o bundle verificado para o UUID canônico. Cada rename é seguido de
   sync do diretório raiz.
7. Só a presença do receipt correspondente no path canônico ativa
   `rust_fs_v1`. Depois disso replay verifica novamente receipt, journal e
   snapshot legado; recovery termina limpeza de staging/backup, mas nunca
   restaura o writer TypeScript.

`nextAuthority.leaseEpoch` é obrigatoriamente
`expectedSourceLeaseEpoch + 1`. Falha normal antes do primeiro rename remove o
guard quando a rejeição é determinística e mantém o bundle TypeScript
authoritative. Crash em qualquer barreira retém transaction/guard/staging
necessários para replay; se a origem já foi movida, a única recuperação válida
é concluir a ativação Rust. Idempotency divergente, epoch stale e mutação entre
as duas inspeções nunca publicam receipt.

## 5. Alternativas rejeitadas

### Manter bundles no Host TypeScript

Reduz trabalho inicial, mas conserva o lifecycle físico, recovery e retenção no
runtime que o programa pretende retirar.

### Cada runner escrever diretamente

Quebra single-writer quando há attempts/filhos concorrentes e mistura o
lifetime curto da execução com a authority durável da sessão.

### Voltar sessões ao SQLite

Reintroduz contenção, acoplamento de schema e blast radius já removidos pela
arquitetura filesystem.

### Daemon global sem lease por sessão

Transforma uma fila lenta ou bundle patológico em bloqueio global. O store pode
ser um serviço/processo compartilhado, mas o scheduling, quota e writer owner
são particionados por sessão.

## 6. Impacto

- `agent-session-store` entra no workspace como crate folha.
- O bridge Host Rust passa a compor o store e a expor somente IDL gerado.
- Engine ganha port de journal/artifact/checkpoint; não ganha paths.
- `TerminalCommitted` passa a depender do receipt do Rust store.
- O projector TypeScript consome records/queries; não escreve bundle.
- Migração de superfície precisa transferir também `storageGeneration`.
- Backups, restore, trash e import/export passam por operações Rust validadas.

## 7. Riscos e rollback

- Crash do writer: recovery valida sequência/hash e trunca apenas tail
  incompleta.
- Writer duplicado: lease epoch e lock físico rejeitam o stale writer.
- Session hot bloqueia outras: atores/filas/quotas independentes por UUID.
- Métricas explodem disco: agregação, segmentos bounded e retenção obrigatória.
- Falha antes da ativação Rust: a geração TypeScript permanece authoritative.
- Falha depois da ativação Rust: reinicia/repara Rust; não há rollback para
  writer TypeScript nem dual-write.

## 8. Gates afetados

- `DUR-001..031`, `OBS-001..008`, `SEC-001..006`;
- `G1-STOR-*`, `G3-PROJ-01`, `G3-EVT-01`, `G5-SPEC-01`;
- `GATE-EVT-01`, `GATE-REC-01`, `GATE-MEM-04..06`;
- `CUT-008..010`, `CUT-018`, `CUT-032`, `CUT-045`, `FINAL-03`.

## 9. Aprovação

Aprovado pelo owner do produto em 2026-07-28. Esta ADR passa a ser a fonte de
verdade para ownership físico de dados de sessão no runtime Rust.
