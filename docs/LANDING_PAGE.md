# CodeStudio — Landing Page (Proposta de conteúdo / Content blueprint)

> **Documento bilíngue PT-BR + EN.** Blueprint completo de conteúdo, copy e design para a futura landing page React do CodeStudio. Todo número/nome técnico foi verificado no código-fonte (ver **Apêndice — Fatos verificados**). Nada de hype: se não está no produto, não está aqui.
>
> **Bilingual doc (PT-BR + EN).** Complete content, copy, and design blueprint for CodeStudio's future React landing page. Every technical claim is verified against the source (see **Appendix — Verified facts**). No hype: if it isn't in the product, it isn't here.

---

## Sumário / Table of contents

0. [Visão geral / Overview](#0-visão-geral--overview)
1. [Identidade visual / Visual identity](#1-identidade-visual--visual-identity)
2. [Estrutura da página / Page structure](#2-estrutura-da-página--page-structure)
3. [Copy completo, seção a seção / Full copy](#3-copy-completo-seção-a-seção--full-copy-section-by-section)
4. [Tom de voz / Voice & tone](#4-tom-de-voz--voice--tone)
5. [Elementos visuais / Visual elements](#5-elementos-visuais--visual-elements)
6. [Stack de implementação / Build stack](#6-stack-de-implementação-sugerido--suggested-build-stack)
7. [Apêndice — Fatos verificados / Verified facts](#apêndice--fatos-verificados--appendix--verified-facts)

---

## 0. Visão geral / Overview

**PT** — O CodeStudio é uma **IDE de desktop *local-first*** (Electron, Win/macOS/Linux) que reúne, num só app, um time de agentes de IA, busca híbrida de código, terminal real, memória persistente, treino local de modelos e um sistema de plugins. O posicionamento da landing é **plataforma tudo-em-um**: amplitude como gancho, com um pilar por capacidade. O modelo é **freemium + BYOK** (você traz suas chaves e paga os provedores direto, sem markup).

**EN** — CodeStudio is a **local-first desktop IDE** (Electron, Win/macOS/Linux) that bundles a team of AI agents, hybrid code search, a real terminal, persistent memory, local model training, and a plugin system into a single app. The landing's positioning is **all-in-one platform**: breadth as the hook, one pillar per capability. The model is **freemium + BYOK** (bring your own keys, pay providers directly, no markup).

**Audiência / Audience:** devs solo, times pequenos e quem precisa de privacidade (código que não pode ir para a nuvem). / Solo devs, small teams, and privacy-sensitive shops (code that can't leave the building).

---

## 1. Identidade visual / Visual identity

A landing **herda os tokens reais do produto** (`apps/dashboard/index.css`) para ficar visualmente coesa com o app. Tema **dark como primário** (combina com IDE; toggle para light). / The landing **inherits the product's real tokens** so it stays visually consistent with the app. **Dark is the primary theme**, light is a toggle.

### 1.1 Paleta de cores / Color palette

**Tema escuro — primário da landing / Dark — landing primary**

| Token | HEX | Uso / Use |
|---|---|---|
| `background` | `#0b0d12` | Fundo da página / Page background |
| `card` | `#14171f` | Cards, painéis / Cards, panels |
| `popover` / `secondary` / `muted` | `#1a1d27` | Superfícies elevadas / Elevated surfaces |
| `foreground` | `#e6e8ee` | Texto principal / Primary text |
| `muted-foreground` | `#8a92a6` | Texto secundário / Secondary text |
| **`primary`** | **`#4d8cff`** | Botões, links, glow / Buttons, links, glow |
| `accent` | `#2a3550` | Destaques sutis / Subtle highlights |
| `accent-foreground` | `#b8c4dd` | Texto sobre accent / Text on accent |
| `border` / `input` | `#20242e` | Bordas, campos / Borders, fields |
| `ring` | `#4d8cff` | Focus ring |
| `success` | `#22c55e` | Status OK |
| `warning` | `#f59e0b` | Status aviso / warning |
| `destructive` | `#ef4444` | Erro / error |

**Tema claro — toggle / Light — toggle**

| Token | HEX |
|---|---|
| `background` | `#fafafb` |
| `card` / `popover` | `#ffffff` |
| `foreground` | `#0b0d12` |
| `muted-foreground` | `#5b6470` |
| **`primary`** | **`#2563eb`** |
| `accent` | `#e6efff` |
| `accent-foreground` | `#1d4ed8` |
| `border` / `input` | `#e4e7ec` |
| `success` / `warning` / `destructive` | `#16a34a` / `#d97706` / `#dc2626` |

**Marca / Brand — gradientes e glows / gradients & glows**

- Azul-marca base / brand base: **`--primary-base #195ab4`**.
- Escala estendida / extended scale (`#d2e5ff → #05132a`): `#d2e5ff` `#b1d2ff` `#87baff` `#6baaff` `#549cff` `#307ae0` `#195ab4` `#10408d` `#0b2859` `#05132a`.
- **Gradiente de hero/CTA / hero & CTA gradient:** `#195ab4 → #4d8cff` (135°). Glows com `#4d8cff` a ~12–20% de opacidade sobre `#0b0d12`.
- Status de marca / brand status: sucesso `#159e5c` · aviso `#f05800` · erro `#eb3d47` · info `#1f7dff`.

**Raio / Radius:** `0.375rem` (6px). **Estilo / Style:** limpo e denso (IDE-like), glassmorphism leve (`backdrop-blur`) em nav e overlays.

### 1.2 Tipografia / Typography

- **Display + corpo / Display + body:** `Inter` (variável / variable).
- **Código + métricas / Code + metrics:** `JetBrains Mono`.
- **Escala da landing (≠ da IDE) / Landing scale:** a IDE é densa (corpo 13px, H1 20px); a **web amplia** — Hero H1 ~`clamp(2.5rem, 6vw, 4rem)`, section H2 ~`2rem`, corpo / body ~`1.0625rem–1.125rem` (17–18px), line-height ~1.6.
- `font-feature-settings` do produto: `"cv11", "ss01", "ss03"` (mantém o look do app).

### 1.3 Estilo / componentes / Style & components

Mesma linguagem do dashboard (**Radix + shadcn/ui**): botões limpos, cards com borda 6px e `ring` vibrante `#4d8cff`. Nav fixa com blur. Seções de feature alternando texto ↔ visual. / Same language as the dashboard (Radix + shadcn/ui): clean buttons, 6px-border cards, vibrant `#4d8cff` ring. Sticky blurred nav. Feature sections alternate text ↔ visual.

---

## 2. Estrutura da página / Page structure

1. **Nav/Header** — logo, links, toggle de tema/idioma, CTA. / logo, links, theme/lang toggle, CTA.
2. **Hero** — headline tudo-em-um + sub + 2 CTAs + mockup dark. / all-in-one headline + sub + 2 CTAs + dark mockup.
3. **Trust bar** — selos de confiança. / trust badges.
4. **6 Pilares** — grid de cards. / pillar card grid.
5. **Deep-dives** — 6 seções alternadas. / 6 alternating sections.
6. **Economia Real / Real Savings** — eficiência e transparência. / efficiency & transparency.
7. **Diferencial de mercado / How we're different** — tabela comparativa. / comparison table.
8. **Como funciona / How it works** — 3 passos. / 3 steps.
9. **Para quem é / Who it's for** — 3 personas.
10. **FAQ** — 8 perguntas. / 8 questions.
11. **CTA final / Final CTA**.
12. **Footer**.

---

## 3. Copy completo, seção a seção / Full copy, section by section

### 3.1 Nav

- **Logo:** `CodeStudio` (texto; aria-label real do produto: "CodeStudio — home").
- **Links / PT:** Recursos · Como funciona · Diferencial · FAQ · GitHub
- **Links / EN:** Features · How it works · Why different · FAQ · GitHub
- **Toggles:** tema (claro/escuro) e idioma (PT/EN). / theme & language.
- **CTA:** `Baixar grátis` / `Download free`

### 3.2 Hero

**Eyebrow / PT:** `IDE local-first · você traz suas chaves · Beta 0.1`
**Eyebrow / EN:** `Local-first IDE · bring your own keys · Beta 0.1`

**H1 / PT:** **A IDE de IA completa — que roda na sua máquina, com as suas chaves.**
**H1 / EN:** **The all-in-one AI IDE — running on your machine, with your own keys.**

**Subheadline / PT:** Um time de agentes, busca híbrida que entende o seu repositório, terminal real e até treino local de modelos. Tudo *in-process*, sem assinatura para ler o seu código e pagando os provedores direto, sem intermediário.

**Subheadline / EN:** A team of agents, hybrid search that actually understands your repo, a real terminal, and even local model training. All in-process — no subscription to read your own code, and you pay providers directly, with no middleman.

**CTA primário / primary:** `Baixar grátis` / `Download free`
**CTA secundário / secondary:** `Ver como funciona` / `See how it works`

**Micro-prova / Micro-proof — PT:** Windows · macOS · Linux — seu código nunca sai da máquina.
**Micro-prova / Micro-proof — EN:** Windows · macOS · Linux — your code never leaves your machine.

### 3.3 Trust bar

**PT:** `100% local-first` · `Você traz suas chaves (BYOK)` · `Índice e embeddings offline` · `Open beta` · `Win / macOS / Linux`
**EN:** `100% local-first` · `Bring your own keys` · `Offline index & embeddings` · `Open beta` · `Win / macOS / Linux`

### 3.4 Os 6 pilares / The 6 pillars

Grid de cards — ícone (lucide) + título + uma frase. / Card grid — lucide icon + title + one line.

| # | Ícone | Título PT / EN | Frase PT | Frase EN |
|---|---|---|---|---|
| 1 | `users` | **Time de agentes** / **A team of agents** | Um master coordena subordinados especializados por stack — planejam, dividem e executam tarefas reais no seu projeto. | A master coordinates stack-specialized subordinates — they plan, split, and execute real tasks across your project. |
| 2 | `search-code` | **Busca híbrida + indexer** / **Hybrid search + indexer** | Indexação incremental com Tree-sitter e busca que funde texto, vetores, recência e grafo de código — com reranker local. | Incremental Tree-sitter indexing and search that fuses full-text, vectors, recency, and a code graph — with a local reranker. |
| 3 | `gauge` | **Economia de token** / **Token efficiency** | Compactação automática, redução inteligente de saídas e catálogo de ferramentas em camadas. Um painel mostra quanto você economizou — de verdade. | Automatic compaction, smart output reduction, and a tiered tool catalog. A panel shows how much you saved — for real. |
| 4 | `shield-check` | **Local-first & BYOK** | Backend roda dentro do app (sem loopback HTTP), índice e embeddings no disco. Suas chaves, seus custos, sem markup. | The backend runs inside the app (no HTTP loopback), index and embeddings on disk. Your keys, your costs, no markup. |
| 5 | `brain-circuit` | **Treino local** / **Local training** | Gere um dataset do seu próprio código, valide com compilador/testes e faça fine-tune de um modelo por stack via QLoRA + Ollama. | Build a dataset from your own code, validate it with the compiler/tests, and QLoRA fine-tune a per-stack model served via Ollama. |
| 6 | `blocks` | **Plugins & pipelines** | Marketplace de plugins assinados e pipelines configuráveis — escolha qual modelo cuida de busca, rerank, resumo, revisão e visão. | A marketplace of signed plugins and configurable pipelines — pick which model handles search, rerank, summarization, review, and vision. |

### 3.5 Deep-dives (os 6 completos / all 6)

> Cada deep-dive: headline + corpo + "fato âncora" verificável. / Each deep-dive: headline + body + a verifiable anchor fact.

#### Pilar 1 — Time de agentes / A team of agents

**PT — Não é um chat. É um time.**
O CodeStudio orquestra um agente *master* que delega para subordinados especializados por stack (ex.: backend, frontend, QA, infra). O master planeja, divide a tarefa, despacha em paralelo e espera o trabalho voltar — cada subordinado roda com seu próprio modelo, ferramentas e *skillset*, e devolve o resultado como uma "investigação" que entra na memória do projeto. Você define **regras operacionais** que chegam, verbatim, ao master e a todo subordinado. E antes de finalizar, o agente pode rodar uma **auto-revisão** dos próprios diffs.

**EN — It's not a chat. It's a team.**
CodeStudio orchestrates a *master* agent that delegates to stack-specialized subordinates (e.g. backend, frontend, QA, infra). The master plans, splits the task, dispatches in parallel, and waits for work to return — each subordinate runs with its own model, tools, and skillset, and returns its result as an "investigation" that lands in the project's memory. You set **operational rules** that reach the master and every subordinate verbatim. And before finishing, the agent can run a **self-review** over its own diffs.

*Fato âncora / Anchor:* o spawn de subordinado herda provider/model/tools do master com override por *spec*, e o resultado é persistido como memória durável. (`packages/company/src/services/subordinate/spawn.ts`, `system-prompts.ts`)

#### Pilar 2 — Busca híbrida + indexer / Hybrid search + indexer

**PT — Ele lê o seu repositório como um sênior leria.**
O indexer usa **Tree-sitter (WASM, offline)** para extrair símbolos, referências e dependências de **20+ linguagens**, e re-indexa de forma **incremental** a cada edição. Na busca, **quatro fontes** são fundidas por *Reciprocal Rank Fusion* (RRF, K=60): full-text (SQLite **FTS5**), **vetorial**, **arquivos recentes** e **expansão por grafo** de chamadas/imports. Um *query planner* sem LLM decide a rota: identificadores vão direto pro full-text (~10 ms); perguntas em linguagem natural acionam o híbrido.

**EN — It reads your repo the way a senior would.**
The indexer uses **Tree-sitter (WASM, offline)** to extract symbols, references, and dependencies across **20+ languages**, re-indexing **incrementally** on every edit. At search time, **four sources** are fused with *Reciprocal Rank Fusion* (RRF, K=60): full-text (SQLite **FTS5**), **vector**, **recently-touched files**, and **call/import graph expansion**. A no-LLM *query planner* picks the route: identifiers hit full-text (~10 ms); natural-language questions trigger hybrid.

*Fato âncora / Anchor:* em queries de código, o modo híbrido **sem reranker** chega a ser *pior* que o full-text puro — R@5 medido **0,64 (híbrido) vs 0,80 (FTS)**. É exatamente por isso que o **reranker local** (cross-encoder `bge-reranker-base`, ONNX/WASM) é essencial na prática: ele reordena o top-K para o híbrido entregar o melhor dos dois mundos. / In code queries, hybrid **without a reranker** can be *worse* than plain full-text — measured R@5 **0.64 (hybrid) vs 0.80 (FTS)**; that's precisely why the **local reranker** re-orders the top-K. Embeddings (`multilingual-e5-small`, PT-BR + EN) e reranker rodam **sem rede** / run **offline**, com cache em `~/.mcp`. (`packages/indexer/src/search/hybrid.ts`, `local-reranker.ts`, `local-embeddings.ts`; baseline em `apps/http-api/server/deps.ts`)

#### Pilar 3 — Economia de token / Token efficiency

**PT — A maioria das ferramentas queima tokens. A nossa mostra a conta — medida.**
Saídas gigantes de ferramentas passam por um *smart reducer* (dedup + âncoras das primeiras/últimas linhas + ranking por relevância à sua pergunta) **antes de chegarem ao modelo**. Em sessões reais isso corta **da ordem de 40% do volume bruto** das saídas, com picos de **70%+** em `spawn_agent` e `code_exec` — e esses chars são **medidos**, não estimados. O contexto é **compactado automaticamente a 70% da janela**, preservando o trabalho recente (tail de 15%) — então sessões longas não degradam nem estouram. O catálogo de ferramentas é revelado **em camadas**, cortando da ordem de **~45k tokens já no 1º turno**. Dois painéis mostram tudo: **Economia do smart reducer** (volume bruto cortado, por ferramenta) e **Economia real** (separa o **exato** do cache da **estimativa** de tiers) — sem inflar número.

**EN — Most tools just burn tokens. Ours shows you the bill — measured.**
Large tool outputs run through a *smart reducer* (dedup + first/last-line anchors + relevance ranking against your question) **before they ever reach the model**. In real sessions that trims **on the order of 40% of the raw output volume**, peaking at **70%+** on `spawn_agent` and `code_exec` — and those chars are **measured**, not estimated. Context is **automatically compacted at 70% of the window**, protecting recent work (a 15% tail) — so long sessions neither degrade nor overflow. The tool catalog is disclosed **in tiers**, trimming on the order of **~45k tokens on turn one**. Two panels show it all: **Smart-reducer savings** (raw volume trimmed, per tool) and **Real Savings** (separating the cache's **exact** from tiers' **estimate**) — no inflated numbers.

*Fato âncora / Anchor:* trigger de compactação `DEFAULT_TRIGGER_RATIO = 0.70`, tail protegido `0.15`. (`packages/code-agent/src/core/runner/compaction/threshold.ts`, `reducers/json-crush.ts`, `sessions/store/telemetry-savings.ts`)

#### Pilar 4 — Local-first & BYOK

**PT — Seu código não vai a lugar nenhum.**
O backend (Hono) roda **dentro do processo do Electron** — sem `child_process`, sem loopback HTTP em produção. O índice, os embeddings e o reranker ficam em **SQLite + arquivos locais** (`~/.mcp`). Suas chaves de API ficam no **SQLite local do app** e só falam com a API do provedor — nunca com um servidor nosso. O sandbox de execução é **opt-in** (containers via Podman). Multi-provedor: Claude, OpenAI, Gemini, DeepSeek e modelos **locais via Ollama**.

**EN — Your code goes nowhere.**
The backend (Hono) runs **inside the Electron process** — no `child_process`, no HTTP loopback in production. The index, embeddings, and reranker live in **SQLite + local files** (`~/.mcp`). Your API keys sit in the **app's local SQLite** and only talk to the provider's API — never to a server of ours. The execution sandbox is **opt-in** (Podman containers). Multi-provider: Claude, OpenAI, Gemini, DeepSeek, and **local models via Ollama**.

*Fato âncora / Anchor:* "BYOK — your key stays in this app's local SQLite, never sent anywhere except the provider's API." (copy real do onboarding / actual onboarding copy, `i18n/locales/en/common.json`)

#### Pilar 5 — Treino local de modelos / Local model training

**PT — Um modelo que fala a língua do seu código.**
A aba **Treino** gera um dataset a partir do *seu* projeto: um LLM-professor cria triplas instrução/entrada/saída *ancoradas* no índice e nos docs (RAG), e um **validador por stack** (`tsc`, ESLint, `pytest`, `go test`…) filtra os exemplos ruins. ~10% vira *holdout* para medir antes/depois. O JSONL final treina um modelo pequeno via **QLoRA**, servido localmente por **Ollama**. Tudo rastreado (datasets, exemplos, runs com loss/VRAM/adaptador).

**EN — A model that speaks your codebase.**
The **Training** tab builds a dataset from *your* project: a teacher LLM creates instruction/input/output triples *grounded* in your index and docs (RAG), and a **per-stack validator** (`tsc`, ESLint, `pytest`, `go test`…) filters out bad examples. ~10% becomes a holdout to measure before/after. The resulting JSONL trains a small model via **QLoRA**, served locally by **Ollama**. Everything is tracked (datasets, examples, runs with loss/VRAM/adapter).

*Fato âncora / Anchor:* tabelas `training_datasets`, `training_examples`, `training_runs`. (`packages/store/src/migrations/121_training_datasets.ts`)

#### Pilar 6 — Plugins & pipelines

**PT — Extensível por fora, configurável por dentro.**
Um **marketplace** de plugins assinados (Ed25519, hospedado em Cloudflare) entrega ferramentas, servidores MCP, *skills*, janelas de UI (webview), comandos e temas — instalados por namespace e executados isolados. Por dentro, os **pipelines** deixam você escolher *qual modelo* cuida de cada papel: embedder, reranker, HyDE, classificador, *scorer*, resumidor de compactação, revisor de código, visão e reescrita de query.

**EN — Extensible on the outside, configurable on the inside.**
A **marketplace** of signed plugins (Ed25519, Cloudflare-hosted) ships tools, MCP servers, skills, webview UI windows, commands, and themes — installed by namespace and run in isolation. On the inside, **pipelines** let you pick *which model* handles each role: embedder, reranker, HyDE, classifier, scorer, compaction summarizer, code reviewer, vision, and query rewriting.

*Fato âncora / Anchor:* catálogo de papéis de pipeline + cliente de marketplace. (`packages/services/src/pipelines/catalog.ts`, `packages/plugin-market-client/src/index.ts`)

> **E ainda / Also in the box:** terminal real, **Builder Studio** (preview ao vivo estilo V0 com edição por clique no elemento), memória persistente da sessão (*Session Drive*) e *vision fallback* (descreve imagens para modelos sem visão). / a real terminal, **Builder Studio** (V0-style live preview with click-to-edit), persistent session memory (*Session Drive*), and *vision fallback* (describes images for vision-less models).

### 3.6 Economia real / Real Savings

**PT — Transparência > marketing.** O CodeStudio não promete economia — ele **mede e mostra**, em dois ângulos:

**1) Economia do smart reducer** — quanto das saídas **brutas** de ferramentas o modelo nunca precisou ler, detalhado por ferramenta. Os chars são **medidos** (a conversão p/ tokens usa 4:1). Exemplo de uma sessão real:

> **Economia do smart reducer — 739,3k chars ≈ 184,8k tokens (41% do bruto)**
> Dominante: `spawn_agent` 313,3k (77% do bruto) · `get_tool_output` 318,4k (44%) · `code_exec` 71,3k (67%) · `read_file` 43,1k (8%) · `mcp__list_directory` 1,2k (9%)

**2) Economia real (resumo da sessão)** — três linhas, honestas sobre a precisão de cada uma:
- **Cache (exato):** quanto você poupou relendo do cache de prompt, na tarifa real (input vs. cache-read).
- **Shaping de tools (forward):** os chars que o smart reducer cortou antes do modelo.
- **Tiers/skills (estimativa):** tokens poupados por não carregar o catálogo inteiro.

A honestidade que vira diferencial: **o smart reducer corta VOLUME** (cabe mais na janela, o modelo relê menos); **o cache é quem mais corta CUSTO**. São complementares — e cada um tem seu painel, sem se misturar. As porcentagens variam por sessão.

**EN — Transparency > marketing.** CodeStudio doesn't promise savings — it **measures and shows** them, from two angles:

**1) Smart-reducer savings** — how much of the **raw** tool output the model never had to read, broken down per tool. The chars are **measured** (the token conversion uses 4:1). A real session:

> **Smart-reducer savings — 739.3k chars ≈ 184.8k tokens (41% of raw)**
> Dominant: `spawn_agent` 313.3k (77% of raw) · `get_tool_output` 318.4k (44%) · `code_exec` 71.3k (67%) · `read_file` 43.1k (8%) · `mcp__list_directory` 1.2k (9%)

**2) Real Savings (session summary)** — three lines, honest about how precise each is:
- **Cache (exact):** saved by re-reading the prompt cache, at the real rate (input vs. cache-read).
- **Tool shaping (forward):** the chars the smart reducer trimmed before the model.
- **Tiers/skills (estimate):** tokens saved by not loading the full catalog.

The honesty that becomes the edge: **the smart reducer cuts VOLUME** (more fits the window, the model re-reads less); **caching cuts the most COST**. They're complementary — each gets its own panel, never conflated. Percentages vary per session.

*(Visual: recriação dos painéis "Economia do smart reducer" (`getToolCallStats`/`tool-stats.ts`) e "Economia real" (`SessionMetricsModal`), com números em `JetBrains Mono`.)*

### 3.7 Diferencial de mercado / How we're different

**PT** — Comparação honesta com o que é típico em Copilot / Cursor / Windsurf. ✅ nativo · ⚠️ parcial/limitado · ❌ ausente.
**EN** — Honest comparison with what's typical in Copilot / Cursor / Windsurf. ✅ native · ⚠️ partial/limited · ❌ absent.

| Capacidade / Capability | CodeStudio | Típico / Typical |
|---|:---:|:---:|
| Backend local *in-process* (sem loopback HTTP) / Local in-process backend | ✅ | ❌ |
| Índice + embeddings + reranker offline / Offline index + embeddings + reranker | ✅ | ⚠️ |
| BYOK sem markup (paga o provedor direto) / BYOK, no markup | ✅ | ❌ |
| Transparência de custo (painel) / Cost transparency (panel) | ✅ | ❌ |
| Multi-agente nativo (master + subordinados) / Native multi-agent | ✅ | ⚠️ |
| Treino local de modelos (QLoRA + Ollama) / Local model training | ✅ | ❌ |
| Plugins assinados + pipelines configuráveis / Signed plugins + configurable pipelines | ✅ | ⚠️ |
| Multi-provedor + modelos locais / Multi-provider + local models | ✅ | ⚠️ |

### 3.8 Como funciona / How it works (3 passos / 3 steps)

1. **PT — Instale e traga suas chaves.** Win/macOS/Linux. Conecte Claude, OpenAI, Gemini, DeepSeek ou um modelo local (Ollama). A chave fica no SQLite local.
   **EN — Install and bring your keys.** Win/macOS/Linux. Connect Claude, OpenAI, Gemini, DeepSeek, or a local model (Ollama). The key stays in local SQLite.
2. **PT — Indexe seu projeto.** Tree-sitter + embeddings locais constroem o índice em `~/.mcp`, em segundo plano, offline. Você já pode buscar enquanto termina.
   **EN — Index your project.** Tree-sitter + local embeddings build the index in `~/.mcp`, in the background, offline. You can search while it finishes.
3. **PT — Converse, construa, treine.** Peça ao time de agentes, edite no Builder Studio com preview ao vivo, ou faça fine-tune de um modelo no seu stack.
   **EN — Chat, build, train.** Ask the agent team, edit in Builder Studio with live preview, or fine-tune a model on your stack.

### 3.9 Para quem é / Who it's for

| Persona | PT | EN |
|---|---|---|
| **Dev solo** / **Solo dev** | Pague só os tokens que usar; veja o gasto em tempo real; rode tudo offline no notebook. | Pay only for the tokens you use; watch spend in real time; run everything offline on your laptop. |
| **Time pequeno** / **Small team** | Agentes especializados + regras operacionais compartilhadas mantêm o padrão do time sem virar uma fatura de plataforma. | Specialized agents + shared operational rules keep the team's standards without becoming a platform bill. |
| **Privacidade-first** / **Privacy-first** | Código nunca sai da máquina; índice, embeddings e chaves locais; sandbox opt-in. Ideal para código sob NDA. | Code never leaves the machine; local index, embeddings, and keys; opt-in sandbox. Great for code under NDA. |

### 3.10 FAQ

1. **Meu código vai para a nuvem? / Does my code go to the cloud?**
   PT: Não. O backend roda dentro do app e o índice/embeddings ficam no disco. Só vão à rede os prompts que *você* mandar para o provedor que *você* escolheu. EN: No. The backend runs inside the app and the index/embeddings stay on disk. The only thing that hits the network is the prompts *you* send to the provider *you* chose.

2. **Preciso de assinatura? / Do I need a subscription?**
   PT: Não. É BYOK — você paga o provedor direto, sem markup. Indexar, buscar e perguntar ao agente sobre o repo está no plano grátis. EN: No. It's BYOK — you pay the provider directly, no markup. Indexing, searching, and asking the agent about your repo is on the free plan.

3. **Funciona offline? / Does it work offline?**
   PT: A indexação, a busca, os embeddings e o reranker são locais e funcionam offline. As chamadas ao LLM dependem do provedor — use Ollama para um fluxo 100% local. EN: Indexing, search, embeddings, and the reranker are local and work offline. LLM calls depend on the provider — use Ollama for a fully local flow.

4. **Quais modelos/provedores são suportados? / Which models/providers?**
   PT: Claude (Anthropic), OpenAI, Gemini (Google), DeepSeek, GLM/Kimi e qualquer endpoint compatível com OpenAI, além de Ollama local. EN: Claude (Anthropic), OpenAI, Gemini (Google), DeepSeek, GLM/Kimi, any OpenAI-compatible endpoint, plus local Ollama.

5. **Posso usar modelos locais? / Can I use local models?**
   PT: Sim — via Ollama. E você pode treinar um modelo pequeno no seu próprio código (QLoRA) e servi-lo localmente. EN: Yes — via Ollama. And you can train a small model on your own code (QLoRA) and serve it locally.

6. **Quais plataformas? / Which platforms?**
   PT: Windows, macOS e Linux (desktop Electron). EN: Windows, macOS, and Linux (Electron desktop).

7. **Preciso de Docker/Podman? / Do I need Docker/Podman?**
   PT: Só se quiser o sandbox de execução em containers — é **opt-in** (Podman). Indexar, buscar e conversar não exigem container. EN: Only if you want the containerized execution sandbox — it's **opt-in** (Podman). Indexing, searching, and chatting don't require a container.

8. **O que é grátis no beta? / What's free in the beta?**
   PT: Indexação, busca híbrida e o agente sobre o seu repo. Você só paga os tokens dos provedores que conectar. EN: Indexing, hybrid search, and the agent over your repo. You only pay for the tokens of the providers you connect.

### 3.11 CTA final / Final CTA

**PT:** **Sua IDE. Suas chaves. Sua máquina.** — Comece grátis hoje. `[ Baixar grátis ]` `[ Ver no GitHub ]`
**EN:** **Your IDE. Your keys. Your machine.** — Start free today. `[ Download free ]` `[ View on GitHub ]`

Plataformas / Platforms: Windows · macOS · Linux.

### 3.12 Footer

- **Colunas / Columns:** Produto/Product (Recursos, Como funciona, Diferencial) · Recursos/Resources (Docs, GitHub, Changelog) · Legal (Licença/License, Privacidade/Privacy).
- **Linha final / Bottom line:** `CodeStudio — local-first AI IDE · Beta 0.1` · toggle PT/EN · © ano.

---

## 4. Tom de voz / Voice & tone

- **Honesto e técnico, sem hype.** Mostrar números reais e separar *exato* de *estimativa* — o copy espelha a filosofia do painel Economia Real. / **Honest and technical, no hype.** Show real numbers; separate *exact* from *estimate* — the copy mirrors the Real Savings panel.
- **Controle e propriedade:** "seu código", "suas chaves", "sua máquina". / Ownership: "your code", "your keys", "your machine".
- **Concreto > adjetivo:** "reranker local sobe o top-5 de 0,64→0,80" em vez de "busca poderosa". / Concrete over adjectives.
- **Bilíngue paralelo:** PT-BR e EN com o mesmo peso; adaptar, não traduzir literalmente. / Parallel bilingual: equal weight, adapt rather than translate literally.

---

## 5. Elementos visuais / Visual elements

- **Hero:** mockup dark do app (chat + diff + terminal) com glow azul `#4d8cff` sobre `#0b0d12`. / dark app mockup with blue glow.
- **Pilar busca / Search pillar:** animação do grafo de símbolos + as 4 fontes fundindo (RRF). / symbol-graph animation + the 4 sources fusing.
- **Pilar economia / Efficiency pillar:** recriação do painel **"Economia do smart reducer"** (barras por ferramenta + "% do bruto", como no produto) ao lado do card "Economia real". É o visual com mais impacto — número grande, medido, com breakdown. / Recreate the **Smart-reducer savings** panel (per-tool bars + "% of raw") next to the Real Savings card; biggest-impact visual.
- **Pilar agentes / Agents pillar:** diagrama master → subordinados (em paralelo). / master → subordinates diagram.
- **Prova / Proof:** snippets de código reais em `JetBrains Mono`. / real code snippets in JetBrains Mono.
- **Movimento / Motion:** sutil — reveal on scroll, glow pulsante no CTA. Respeitar `prefers-reduced-motion`. / subtle reveal on scroll, pulsing CTA glow; honor `prefers-reduced-motion`.

---

## 6. Stack de implementação sugerido / Suggested build stack

Para a futura landing React (rodada separada) — **reaproveitar a stack do dashboard** para herdar tokens e componentes. / For the future React landing (separate round) — reuse the dashboard stack to inherit tokens and components.

- **React 19 + Vite + Tailwind 4 + shadcn/ui** (mesma do `apps/dashboard`).
- Copiar `:root`/`.dark` de `apps/dashboard/index.css` → tema instantâneo. / Copy the token blocks for an instant theme.
- `Inter` + `JetBrains Mono` via Google Fonts (com fallback de sistema, como no produto). / via Google Fonts with system fallback.
- i18n: `react-i18next` (já é o padrão do produto) com namespaces `pt-BR`/`en`. / already the product standard.
- Deploy: estático — Cloudflare Pages/Workers (a conta `CodeStudio` já existe na infra). / static — Cloudflare Pages/Workers.

---

## Apêndice — Fatos verificados / Appendix — Verified facts

Cada alegação da landing tem respaldo no código. / Every landing claim is backed by source.

| Alegação / Claim | Arquivo / File |
|---|---|
| Busca híbrida (FTS5 + vetor + recência + grafo, RRF K=60) | `packages/indexer/src/search/hybrid.ts`, `hybrid-pipeline.ts` |
| Reranker local essencial (sem ele, híbrido R@5 0,64 < FTS 0,80) | `packages/indexer/src/search/local-reranker.ts`; baseline medido em `apps/http-api/server/deps.ts` |
| Embeddings locais `multilingual-e5-small` (ONNX/WASM) | `packages/indexer/src/search/local-embeddings.ts` |
| Query planner (identifier→FTS, NL→hybrid) | `packages/indexer/src/search/planner.ts` |
| Indexação incremental Tree-sitter | `packages/indexer/src/indexer/incremental.ts`, `tree-sitter/` |
| Smart reducer (json-crush) | `packages/code-agent/src/core/reducers/json-crush.ts` |
| Compactação a 70% (tail 15%) | `packages/code-agent/src/core/runner/compaction/threshold.ts` |
| Painel "Economia real" (cache exato / shaping / tiers) | `packages/code-agent/src/sessions/store/telemetry-savings.ts`; UI `apps/dashboard/features/chat/SessionMetricsModal.tsx` |
| Painel "Economia do smart reducer" (raw vs shaped, % do bruto, por ferramenta) | `packages/code-agent/src/sessions/store/tool-stats.ts` (`getToolCallStats`); labels `toolStats.*` em `apps/dashboard/i18n/locales/pt-BR/chat.json` |
| Smart reducer (a transformação medida no painel) | `packages/code-agent/src/core/smart-reducers.ts`, `reducers/json-crush.ts`; coluna `output_chars_shaped` (mig. 102) |
| Tool tiering (~45k tokens no 1º turno) | `packages/code-agent/src/tools/tiers.ts` |
| Multi-agente (master + subordinados, regras operacionais) | `packages/company/src/services/subordinate/spawn.ts`, `system-prompts.ts` |
| Self-review nudge | `packages/code-agent/src/core/runner/nodes/executing-self-review.ts` |
| Memória / Session Drive | `packages/services/src/memory/distiller.ts`, `retriever.ts`; `packages/code-agent/src/sessions/store/session-drive.ts` |
| Treino local (QLoRA + Ollama) | `packages/store/src/migrations/121_training_datasets.ts` |
| Plugins (marketplace assinado) + pipelines | `packages/plugin-market-client/src/index.ts`; `packages/services/src/pipelines/catalog.ts` |
| Vision fallback | `packages/code-agent/src/core/vision-describer.ts` |
| Builder de projeto (V0-style) | `packages/code-agent/src/prompts/builder.txt`; `apps/dashboard/features/project/builder/` |
| BYOK / local-first / sandbox opt-in (copy real) | `apps/dashboard/i18n/locales/en/common.json` (`onboarding.*`, `preflight.*`) |
| Paleta de cores (tokens) | `apps/dashboard/index.css` |
| Multi-provedor + caps de modelo | `packages/code-agent/src/providers/model-registry.ts` |
