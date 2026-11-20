# Session Workbench benchmark fixture

Fixture determinística e sem acesso ao storage real para os gates de escala do
Chat Session Workbench.

## Gerar e validar

```powershell
node benchmarks/session-workbench/fixture.mjs
```

Sem argumentos, o comando gera e valida os catálogos obrigatórios de 1.000 e
10.000 sessões. Tamanhos específicos podem ser informados como argumentos.

Invariantes da fixture:

- IDs canônicos e únicos;
- distribuição determinística de 40 projetos, 120 grupos, providers e status;
- presença de runs ativos, sessões arquivadas, favoritas, com unread e sem
  grupo;
- nenhum acesso a SQLite, bundles ou sessões do usuário;
- limite de segurança de 100.000 itens.

O mesmo generator deve ser reutilizado pelos benchmarks de list/query em S1 e
de virtualização/navegação em S4, evitando fixtures divergentes.

## Medir o read model HTTP

```powershell
npx tsx benchmarks/session-workbench/read-model.mts
```

O benchmark monta a rota em processo, consulta páginas de 100 itens sobre
os catálogos de 1.000 e 10.000 sessões e falha se o read model hidratar mais de
100 bundles. Ele não abre o storage real nem exige reiniciar o backend ativo.

## Validar o transporte HTTP

```powershell
npx tsx benchmarks/session-workbench/live-smoke.mts
```

O smoke monta as rotas públicas reais em uma porta TCP efêmera e valida o
envelope de erro e conditional GET para list, bootstrap e recurso lazy. Ele não
inicia nem altera a instalação empacotada do CodeStudio.
