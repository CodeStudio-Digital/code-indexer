# Política de supply chain

Esta política é obrigatória para todos os crates de `native/agent-runtime`.

## Admissão de dependências

Toda dependência nova deve:

1. ter necessidade funcional registrada no PR;
2. possuir licença compatível com MIT e distribuição comercial;
3. não estar yanked nem possuir advisory não mitigado;
4. declarar features explicitamente, com defaults desligados quando possível;
5. evitar dependências duplicadas e cadeias nativas sem necessidade;
6. ser fixada pelo `Cargo.lock` versionado;
7. passar por `cargo tree`, auditoria de advisory e revisão de licença.

Git dependencies, registries desconhecidos, wildcards e patches locais não
versionados são proibidos. Exceção exige ADR, commit imutável e prazo de remoção.

Código `unsafe` próprio é proibido fora de módulos mínimos de FFI pertencentes a
`agent-platform`. Cada exceção exige ADR, comentário `SAFETY`, teste da
invariante e uma API pública safe; os demais crates mantêm o lint em `deny`.

## Execução de CI

O gate de supply chain deve executar, no mínimo:

```text
cargo metadata --locked --format-version 1
cargo tree --workspace --locked
cargo audit
cargo deny check
```

O lockfile continua obrigatório. O grafo inicial admite somente:

- `prost` e sua cadeia para o wire Protobuf gerado;
- `sha2` para SHA-256 normativo cross-language;
- `zeroize`, com defaults desligados e somente a feature de alocação necessária,
  para apagar buffers de segredo sem depender de `Vec::fill(0)` ou `unsafe`
  próprio; versão, licença e advisories seguem os mesmos gates desta política;
- `tokio` com features explícitas para framing, channels, timers e IPC local;
- `mio` e `socket2`, transitivos de `tokio/net`, para readiness de Named
  Pipe/UDS; `wasi` aparece apenas como aresta target-specific transitiva;
- `windows-sys`, target-specific e com features mínimas, para Job Objects e
  lifecycle/ACL/Named Pipe no adapter Windows.

Qualquer aresta externa nova ou alteração inesperada no lockfile bloqueia merge
até revisão explícita.

## Atualização

Atualizações de toolchain e crates são PRs próprios. Elas devem incluir testes
do workspace, auditoria, diff do grafo e build dos targets suportados. Build
scripts, proc macros, bindings nativos e código `unsafe` de terceiros recebem
revisão explícita.
