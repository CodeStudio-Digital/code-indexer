# Avaliação Ultra v3

`corpus.json` congela 30 tarefas: 6 simples, 8 implementações, 4 investigações, 4 recovery, 4 tools e 4 follow-ups. Dez são holdout. Este arquivo especifica entradas e oráculos; não contém resultados nem implementa todos os adaptadores de fixture. A automação completa do corpus é B11 progressivo.

O harness existente `scripts/bench-agent-effectiveness-live.ts` agora aceita `--execution-mode standard|ultra` e `--reasoning-effort high`. Registra o modo, esforço, identidade das fontes e ledger agregado quando disponível. O caso `ultra_parallel_integration` semeia dois defeitos independentes e exige workflow, duas integrações autorizadas e testes aprovados. É um teste de integração, não uma comparação justa entre modos.

Executar em perfil descartável usando `scripts/bench-agent-reliability-live.ts`, que reutiliza somente a configuração Z.ai autorizada e limpa as credenciais do perfil ao sair. Não publicar os perfis. Exemplo em PowerShell, na raiz:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
node_modules/.bin/electron.cmd node_modules/tsx/dist/cli.mjs scripts/bench-agent-reliability-live.ts --execution-mode ultra --reasoning-effort high --cases fix_expiry_boundary --repetitions 1 --max-minutes 5 --max-estimated-usd 1
```

O limite em dólares desse harness é uma estimativa entre casos, não um teto de faturamento por requisição. Preço desconhecido no ledger permanece `null`. Uso do pai isoladamente não serve para comparar custo de workflows; usar `aggregate_budget` e os registros de tentativas.

Para promover qualidade: preparar fixtures/oráculos do corpus, fixar revisões separadas da baseline e da candidata, usar as mesmas entradas/modelo/esforço/limites e três repetições por variante. O modo Ultra antigo deve rodar no checkout antigo; renomear o modo da candidata não produz uma baseline. Publicar resultados pareados, falhas, P50/P95, custo por tarefa correta, incerteza e limitações. Não ajustar prompts depois de abrir o holdout.
