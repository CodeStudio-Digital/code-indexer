# Propriedade dos processos de teste no Windows

Desde 2026-10-07, execuções de teste/build deste trabalho usam
`scripts/run-tracked-test.ps1` com uma especificação JSON e um diretório novo
de evidências. O supervisor registra seu PID antes de iniciar o processo raiz.
O processo raiz nasce suspenso, entra em um Job Object com
`KILL_ON_JOB_CLOSE` e somente então executa. Descendentes Node, Electron,
Rust, shells e processos detached permanecem no mesmo grupo do sistema.

Cada diretório contém:

- `run.json`: PID e criação do supervisor, executável e especificação.
- `processes.jsonl`: PID da raiz e notificações de início/fim dos descendentes.
- `stdout.log` e `stderr.log`: saída sem depender da sessão do terminal.
- `cleanup.json`: total de processos, timeout, limpezas forçadas e
  `verifiedEmpty`, confirmado pela contagem do Job no Windows.

Depois de a raiz terminar, filhos têm dois segundos para sair. Os restantes
são encerrados pelo Job, com espera de até 15 segundos pela contagem zero.
Timeout encerra a árvore inteira e devolve código 124. Se o supervisor cair,
o fechamento do último handle do Job solicita o encerramento da árvore.
Uma execução sem `cleanup.json` com `verifiedEmpty: true` não tem confirmação
de cleanup. PIDs não são reutilizados para uma limpeza por nome: a autoridade
é o handle do Job, evitando atingir processos de outras tarefas ou do usuário.

Exemplo de especificação:

```json
{"executable":"node","arguments":["scripts/test-harness-tools.mjs"],"timeoutSeconds":600}
```

```powershell
pwsh -NoProfile -File scripts/run-tracked-test.ps1 -Spec scratch/test-spec.json -RunDirectory scratch/test-processes-run-01
```

Provas iniciais em `scratch/harness-20261003/`: `process-job-selftest-r4`
encerrou dois descendentes detached deixados pela raiz; `process-job-timeout-r1`
encerrou quatro processos ativos no timeout. Ambos confirmaram zero ativos.
`process-job-crash-processes` matou deliberadamente o supervisor interno e
confirmou o fim dos quatro PIDs do Job interno antes de a raiz externa sair;
nenhum dos oito processos da execução externa precisou de limpeza forçada.
A matriz `native-session-data-packaged-r2-processes` registrou **441 processos**,
todos encerrados naturalmente, sem limpeza forçada. Estes números pertencem
a essas execuções; não certificam retrospectivamente processos de testes antigos.
