# 06 — Bake-off de motores open source

> **Status:** Codex B2 físico completo; B3 comparativo pendente
> **Branch:** `codex/oss-agent-bakeoff`
> **Baseline:** `7e79171d4c9a98397d3f47d9437d890e9316dc1d`
> **Escopo:** certificação e comparação; nenhum cutover de produto

## 1. Decisão

O primeiro experimento NÃO cria um fork de produto. Codex app-server e Goose
são tratados como motores descartáveis atrás de um adapter. O control plane,
as attempts, policy/fencing, catálogo autorizado, ToolHost, session store e
telemetria continuam sendo autoridades do CodeStudio.

```text
control plane TS
  -> supervisor/runner single-tenant
    -> engine adapter
      -> processo do candidato
        -> chamadas autorizadas no ToolHost
```

Adotar código ou criar fork só pode ser uma decisão posterior, baseada no
bake-off. Atualização upstream não pode exigir reescrever contratos de produto.

## 2. Fronteira do adapter

Todo adapter implementa o mesmo contrato:

- uma instância pertence a exatamente um `AgentRunAttempt`;
- capabilities são recebidas como snapshot imutável antes do start;
- o processo candidato não recebe store, registry ou callback interno;
- eventos são normalizados para lifecycle tipado;
- tool call só executa pelo port do ToolHost;
- interação, approval e cancel são correlacionados com attempt/thread/turn;
- encerramento remove estado efêmero do candidato e entrega o processo ao
  owner responsável pelo reap;
- versão e protocolo do candidato são pinados e registrados no relatório.

O adapter não traduz centenas de flags. Ele recebe uma política resolvida e
produz o menor conjunto possível de opções do candidato.

## 3. Regras eliminatórias

Um candidato é rejeitado como engine de produção se qualquer item abaixo
depender de patch profundo no seu core:

1. impedir tools mutantes embutidas de contornar o ToolHost;
2. fixar o catálogo de capabilities durante a attempt;
3. distinguir `accepted`, `started`, `terminal` e `outcome_unknown`;
4. interromper e reapear todo o process tree;
5. não repetir mutação depois de ACK ambíguo;
6. impedir que o armazenamento do candidato vire a verdade da sessão;
7. aplicar deadline e resource grant externos;
8. correlacionar todos os eventos à attempt ativa;
9. operar sem segredo no prompt, journal ou argv;
10. manter schema/prompt dentro dos budgets aprovados.

Built-ins que não podem ser desabilitados ficam em sandbox read-only e têm
approval negado pelo adapter durante o spike. Isso permite medir raciocínio,
mas não certifica o candidato para mutações de produção.

## 4. Candidatos

### Codex app-server

Primeiro adapter por possuir protocolo JSONL/JSON-RPC documentado, lifecycle de
threads/turns/items e dynamic tools executadas pelo cliente. A integração usa
somente API estável, exceto `dynamicTools`, que fica explicitamente marcada
como dependência experimental e gate de risco.

O CodeStudio nunca faz resume do thread do candidato como fonte de verdade.
Durante o spike, o thread criado é deletado no teardown sempre que o protocolo
permite.

### Goose

Segundo candidato. Antes do adapter de execução, a versão pinada precisa provar
uma API session-scoped e um mecanismo de extensions sem estado global. Variável
de ambiente `GOOSE_*` não é mapeada para a nova `RuntimePolicy`; qualquer
configuração necessária fica confinada ao launcher do candidato.

## 5. Fases do bake-off

### B0 — Conformance local

- tipos e validação do contrato neutro;
- peer JSON-RPC bounded;
- handshake Codex;
- tradução de lifecycle;
- deny fail-closed para requests desconhecidos e built-ins;
- tool call correlacionada ao snapshot autorizado;
- cancel/terminal/teardown;
- testes com peer sintético, sem credencial ou modelo.

### B1 — Processo real read-only

- versão e schema pinados;
- uma attempt por processo;
- prompt trivial e tarefa de navegação;
- nenhum write, shell mutante ou network não autorizado;
- medição de startup, primeiro byte, RSS, handles e cleanup.

### B2 — ToolHost sintético

- `capability_catalog` e conjunto pequeno de tools;
- resultado grande com preview/artifact;
- timeout, cancel e erro;
- chamada mutante simulada com ACK perdido;
- tentativa de capability fora do snapshot.

### B3 — Corpus comparativo

Executar o corpus P3 da spec de migração com o mesmo modelo, esforço, workspace,
policy, capabilities e budgets em cada engine. O legado e o engine Rust próprio
são controles, não fallbacks concorrentes.

## 6. Métricas e gates

Registrar por attempt:

- engine/version/protocol/schema digest;
- tempo de spawn, initialize, thread start, turn start e primeiro delta;
- bytes de prompt e schemas;
- primeira tool correta e chamadas totais;
- tokens/custo quando fornecidos pelo provider;
- status terminal, cancel latency e process-tree cleanup;
- tool calls rejeitadas, duplicadas ou fora do snapshot;
- estado temporário criado e removido.

Gates de segurança e lifecycle exigem 100%. Desempenho e qualidade são
comparados ao baseline; uma melhora não compensa violação de autoridade.

## 7. Decisão após o bake-off

- **adapter:** candidato passa sem patches no core e entrega ganho material;
- **component donor:** ideias ou módulos úteis, mas runtime não passa os gates;
- **fork:** somente com ADR separado, owner de upstream merge e custo medido;
- **rejeitado:** precisa controlar sessão, policy, tools ou processo fora dos
  nossos contratos.

Nenhum resultado deste spike muda o runtime selecionado no produto.
