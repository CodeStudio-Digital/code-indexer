# MCP Code Indexer v3.1 — Especificação Completa

## Changelog v3.0 → v3.1

| Feature | Status | Seção |
|---|---|---|
| Busca semântica via embeddings (Cloudflare Workers AI + Vectorize) | **NOVO** | §8 |
| Context snapshots (memória de projeto) | **NOVO** | §9 |
| File watcher (daemon de re-indexação) | **NOVO** | §10 |
| Webhooks (notificação pós-indexação) | **NOVO** | §11 |
| Export (gerar documentação markdown) | **NOVO** | §12 |
| Diff de versões (comparar runs) | **NOVO** | §13 |
| Custos (tracking de tokens e $ por run) | **NOVO** | §14 |
| Provider Z.AI / Zhipu (GLM) | v3.0 | §7.3 |
| Descoberta dinâmica de modelos | v3.0 | §7.5 |
| Multi-projeto (projects table) | v3.0 | §5 |
| Dashboard web | v3.0 | §16 |

---

## 1. Visão Geral

**Nome:** `mcp-code-indexer`
**Versão:** 3.1.0
**Descrição:** Plataforma completa de indexação de codebase alimentada por LLM com busca híbrida (FTS5 + embeddings vetoriais), suporte a múltiplos projetos, dashboard web, memória de contexto, file watcher, webhooks, export de documentação, diff de versões e tracking de custos. Serve como "memória persistente" do codebase para agentes de IA via MCP Server + API REST.

---

## 2. Arquitetura Geral

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MCP Code Indexer v3.1                            │
├───────────────┬────────────────────┬────────────────────────────────┤
│  CLI          │  MCP Server        │  Dashboard (React SPA)         │
│  (index,      │  (stdio transport) │  + API REST (Hono)             │
│  search,      │  Tools para        │  + SSE (progresso em           │
│  watch,       │  Claude Code       │    tempo real)                 │
│  export,      │                    │                                │
│  diff, cost)  │                    │                                │
├───────────────┴────────────────────┴────────────────────────────────┤
│                         Core Engine                                  │
│  ┌────────────┐ ┌──────────────┐ ┌────────────────┐ ┌────────────┐ │
│  │FileScanner │ │ IndexAgent   │ │ Provider Layer │ │ Embedding  │ │
│  │(glob+hash) │ │ (orquestra   │ │ (6 providers)  │ │ Service    │ │
│  │            │ │  paralelo)   │ │                │ │ (CF AI)    │ │
│  └────────────┘ └──────────────┘ └────────────────┘ └────────────┘ │
│  ┌────────────┐ ┌──────────────┐ ┌────────────────┐ ┌────────────┐ │
│  │FileWatcher │ │ CostTracker  │ │ Webhook        │ │ Exporter   │ │
│  │(chokidar)  │ │ (tokens+$)   │ │ Dispatcher     │ │ (markdown) │ │
│  └────────────┘ └──────────────┘ └────────────────┘ └────────────┘ │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Model Discovery — GET /models em cada provider (cache 24h)  │   │
│  └──────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  Storage Layer                                                       │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │ SQLite (better-sqlite3)     │  │ Cloudflare (cloud)           │  │
│  │ ├── projects                │  │ ├── Workers AI bge-m3        │  │
│  │ ├── files (+FTS5)           │  │ │   (embeddings, 10K         │  │
│  │ ├── symbols (+FTS5)         │  │ │    neurons/dia grátis)     │  │
│  │ ├── runs                    │  │ └── Vectorize                │  │
│  │ ├── snapshots               │  │     (vector DB, 50M dims/    │  │
│  │ ├── costs                   │  │      mês inclusos no $5)     │  │
│  │ ├── webhooks                │  └──────────────────────────────┘  │
│  │ ├── models_cache            │                                    │
│  │ └── file_snapshots (diff)   │  Diretório: ~/.mcp-code-indexer/   │
│  └─────────────────────────────┘  ├── index.db (SQLite)             │
│                                   └── exports/ (markdown gerados)  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Stack Tecnológica

| Componente | Tecnologia |
|---|---|
| Linguagem | TypeScript (ESM, `"type": "module"`) |
| Runtime | Node.js ≥ 20 |
| Banco relacional | SQLite via `better-sqlite3` |
| Busca keyword | SQLite FTS5 (unicode61, remove_diacritics) |
| Busca vetorial | Cloudflare Vectorize (via HTTP API / Worker proxy) |
| Embeddings | Cloudflare Workers AI `@cf/baai/bge-m3` (1024 dims, **grátis** nos 10K neurons/dia) |
| MCP SDK | `@modelcontextprotocol/sdk` (stdio transport) |
| API REST | Hono |
| Dashboard | React SPA (Vite + Tailwind) |
| File Watcher | `chokidar` |
| LLM Providers | Anthropic SDK, OpenAI SDK (+DeepSeek, +Z.AI), Google Generative AI SDK |
| File scanning | `glob` + `ignore` |
| Validação | `zod` |
| Build | `tsc` / Vite |

---

## 4. Estrutura de Diretórios

```
mcp-code-indexer/
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts
│   ├── cli.ts
│   ├── agent/
│   │   ├── indexer.ts                    # Orquestrador de indexação
│   │   ├── scanner.ts                   # FileScanner (glob + gitignore + hash)
│   │   └── providers/
│   │       ├── base.ts                   # Interface LLMProvider + prompt + parser
│   │       ├── anthropic.ts
│   │       ├── openai.ts
│   │       ├── deepseek.ts
│   │       ├── gemini.ts
│   │       ├── zai.ts                    # Z.AI / Zhipu (GLM)
│   │       ├── factory.ts
│   │       └── model-discovery.ts
│   ├── search/
│   │   ├── hybrid.ts                    # Hybrid search (FTS5 + Vectorize, RRF merge)
│   │   └── embeddings.ts               # Embedding service (Cloudflare Workers AI)
│   ├── store/
│   │   ├── db.ts                         # SQLite layer (multi-project)
│   │   └── vectors.ts                   # Cloudflare Vectorize client
│   ├── services/
│   │   ├── watcher.ts                   # File watcher daemon (chokidar)
│   │   ├── webhooks.ts                  # Webhook dispatcher
│   │   ├── exporter.ts                  # Export markdown/docs
│   │   ├── differ.ts                    # Diff entre runs
│   │   ├── costs.ts                     # Cost tracker
│   │   └── snapshots.ts                # Context snapshots
│   ├── api/
│   │   └── server.ts                     # API REST (Hono)
│   ├── mcp/
│   │   └── server.ts                     # MCP Server (stdio)
│   ├── dashboard/
│   │   ├── index.html
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── ProjectList.tsx
│   │   │   ├── ProjectDetail.tsx
│   │   │   ├── SearchPanel.tsx
│   │   │   ├── IndexingStatus.tsx
│   │   │   ├── ProviderConfig.tsx
│   │   │   ├── ModelSelector.tsx
│   │   │   ├── CostDashboard.tsx
│   │   │   ├── DiffViewer.tsx
│   │   │   ├── SnapshotEditor.tsx
│   │   │   └── WebhookManager.tsx
│   │   └── hooks/
│   │       └── useApi.ts
│   └── utils/
│       └── config.ts
└── dist/
```

---

## 5. Multi-Projeto

### 5.1 Tabela `projects`

```sql
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  root_path     TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  provider      TEXT,
  model         TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  last_indexed  TEXT,
  file_count    INTEGER NOT NULL DEFAULT 0,
  symbol_count  INTEGER NOT NULL DEFAULT 0
);
```

### 5.2 Identificação pelo Claude Code

O MCP Server resolve o projeto em 3 modos (prioridade):

1. **Por nome** — `project_name: "zapcode-api"`
2. **Por path** — `project_root: "/home/maicon/zapcode/api"` (match exato ou suffix)
3. **Auto-detect** — infere pelo cwd se não informado

Auto-registra se não existir: nome = últimos 2 segmentos do path, ex: `/home/maicon/zapcode/api` → `zapcode-api`.

---

## 6. Tipos Completos (src/types.ts)

```typescript
// ═══════════════════════════════════════════
//  PROJETO
// ═══════════════════════════════════════════
export interface Project {
  id: number;
  name: string;
  root_path: string;
  description: string;
  provider?: string;
  model?: string;
  created_at: string;
  updated_at: string;
  last_indexed?: string;
  file_count: number;
  symbol_count: number;
}

// ═══════════════════════════════════════════
//  ANÁLISE LLM
// ═══════════════════════════════════════════
export interface LLMFileAnalysis {
  language: string;
  summary: string;
  concepts: string[];
  dependencies: string[];
  internal_deps: string[];
  notes: string[];
  complexity: "low" | "medium" | "high";
  symbols: LLMSymbol[];
}

export interface LLMSymbol {
  name: string;
  kind: string;
  signature: string;
  parent?: string;
  modifiers: string[];
  return_type?: string;
  parameters?: string;
  line?: number;
  comment: string;
  tags: string[];
}

// ═══════════════════════════════════════════
//  DB RECORDS
// ═══════════════════════════════════════════
export interface DBFile {
  id: number;
  project_id: number;
  path: string;               // relativo ao project root
  language: string;
  size_bytes: number;
  line_count: number;
  content_hash: string;       // SHA256
  indexed_at: string;
  summary: string;
  concepts: string;           // JSON array
  dependencies: string;       // JSON array
  internal_deps: string;      // JSON array
  notes: string;              // JSON array
  complexity: string;
  fts_content: string;
}

export interface DBSymbol {
  id: number;
  project_id: number;
  file_path: string;
  name: string;
  kind: string;
  signature: string;
  parent: string | null;
  modifiers: string;          // JSON array
  return_type: string | null;
  parameters: string | null;
  line: number | null;
  comment: string;
  tags: string;               // JSON array
}

// ═══════════════════════════════════════════
//  RUNS (com custos integrados)
// ═══════════════════════════════════════════
export interface IndexRun {
  id: number;
  project_id: number;
  project_root: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "done" | "failed";
  total_files: number;
  indexed_files: number;
  skipped_files: number;
  error_count: number;
  provider: string;
  model: string;
  // Custos (v3.1)
  input_tokens: number;
  output_tokens: number;
  embedding_tokens: number;
  estimated_cost_usd: number;
}

// ═══════════════════════════════════════════
//  CUSTOS
// ═══════════════════════════════════════════
export interface CostRecord {
  id: number;
  project_id: number;
  run_id: number;
  provider: string;
  model: string;
  operation: "analysis" | "embedding";
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface CostSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_embedding_tokens: number;
  by_provider: Record<string, { cost_usd: number; tokens: number }>;
  by_project: Record<string, { cost_usd: number; runs: number }>;
  by_period: Array<{ date: string; cost_usd: number }>;
}

// ═══════════════════════════════════════════
//  CONTEXT SNAPSHOTS
// ═══════════════════════════════════════════
export interface ContextSnapshot {
  id: number;
  project_id: number;
  title: string;
  category: "architecture" | "decision" | "pattern" | "convention" | "todo" | "note";
  content: string;            // markdown livre
  tags: string;               // JSON array
  created_at: string;
  updated_at: string;
  created_by: string;         // "user" | "auto" | "claude"
}

// ═══════════════════════════════════════════
//  WEBHOOKS
// ═══════════════════════════════════════════
export interface Webhook {
  id: number;
  project_id: number | null;  // null = global (todos os projetos)
  url: string;
  events: string;             // JSON array: ["index.done", "index.failed", "watch.changed"]
  secret?: string;            // HMAC-SHA256 signing secret
  active: boolean;
  created_at: string;
  last_triggered: string | null;
  last_status: number | null; // HTTP status code
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  project: { id: number; name: string; root_path: string };
  data: Record<string, any>;  // event-specific payload
}

// ═══════════════════════════════════════════
//  DIFF
// ═══════════════════════════════════════════
export interface RunDiff {
  run_before: number;
  run_after: number;
  files_added: DiffFileEntry[];
  files_removed: DiffFileEntry[];
  files_modified: DiffFileModified[];
  symbols_added: DiffSymbolEntry[];
  symbols_removed: DiffSymbolEntry[];
  concepts_added: string[];
  concepts_removed: string[];
  summary: string;            // resumo gerado do diff
}

export interface DiffFileEntry {
  path: string;
  language: string;
  summary: string;
}

export interface DiffFileModified {
  path: string;
  language: string;
  summary_before: string;
  summary_after: string;
  symbols_added: string[];
  symbols_removed: string[];
  concepts_changed: { added: string[]; removed: string[] };
}

export interface DiffSymbolEntry {
  name: string;
  kind: string;
  file_path: string;
  signature: string;
}

// ═══════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════
export interface ExportOptions {
  project_id: number;
  format: "markdown" | "json";
  sections: ExportSection[];
  output_path?: string;       // default: ~/.mcp-code-indexer/exports/{project}.md
  include_snapshots?: boolean;
  include_costs?: boolean;
}

export type ExportSection =
  | "overview"        // project summary, stats, linguagens
  | "architecture"    // conceitos, dependências entre arquivos, grafo
  | "files"           // lista de arquivos com summaries
  | "symbols"         // catálogo de símbolos por tipo
  | "concepts"        // mapa de conceitos → arquivos
  | "api"             // entry-points, rotas, handlers
  | "snapshots"       // context snapshots
  | "changelog";      // diff do último run

// ═══════════════════════════════════════════
//  MODEL DISCOVERY
// ═══════════════════════════════════════════
export interface DiscoveredModel {
  id: string;
  provider: string;
  owned_by?: string;
  created?: number;
  capabilities?: string[];
  cached_at: number;
}

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════
export interface IndexerConfig {
  dbPath?: string;
  provider?: string;
  model?: string;
  maxFileSizeKB?: number;
  concurrency?: number;
  ignore?: string[];
  forceReindex?: boolean;
  // v3.1
  embeddings?: {
    enabled: boolean;
    workerUrl: string;          // URL do Worker proxy Cloudflare
    workerToken: string;        // shared secret
    model: string;              // ex: "@cf/baai/bge-m3"
    dimensions?: number;        // default: 1024 (bge-m3)
  };
  watcher?: {
    enabled: boolean;
    debounceMs?: number;      // default: 2000
    autoIndex?: boolean;      // re-indexa automático? default: true
  };
  webhooks?: WebhookConfig[];
  costTracking?: boolean;     // default: true
}

export interface WebhookConfig {
  url: string;
  events: string[];
  secret?: string;
}
```

---

## 7. Provider Abstraction Layer

### 7.1 Interface Base (base.ts)

```typescript
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  analyzeFile(filePath: string, content: string): Promise<LLMFileAnalysis>;
}

// Resultado com tokens para cost tracking
export interface AnalysisResult {
  analysis: LLMFileAnalysis;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
```

Cada provider retorna `AnalysisResult` em vez de `LLMFileAnalysis` diretamente, para que o `CostTracker` possa acumular tokens.

### 7.2 System Prompt (SYSTEM_PROMPT)

Instrui o LLM a retornar JSON no schema `LLMFileAnalysis`. Cobre: classes, funções, interfaces, enums, constantes; comment semântico por símbolo; detecção de conceitos; dependências internas/externas; complexidade; edge cases (config, SQL, markdown).

### 7.3 Providers (6 total)

| Provider | SDK | Env Var | Default Model | Cheapest | Base URL |
|---|---|---|---|---|---|
| `anthropic` | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | mesmo | `https://api.anthropic.com` |
| `openai` | `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` | mesmo | `https://api.openai.com/v1` |
| `deepseek` | `openai` | `DEEPSEEK_API_KEY` | `deepseek-chat` | mesmo | `https://api.deepseek.com` |
| `gemini` | `@google/generative-ai` | `GEMINI_API_KEY` | `gemini-2.0-flash` | `gemini-2.0-flash-lite` | (SDK) |
| `zai` | `openai` | `ZAI_API_KEY` | `glm-4.7-flash` | mesmo (grátis) | `https://api.z.ai/api/paas/v4/` |

#### Z.AI / Zhipu (zai.ts)

```typescript
import OpenAI from "openai";

export const ZAI_MODELS = {
  "glm-4.7-flash":       "glm-4.7-flash",        // GRÁTIS
  "glm-4.5-flash":       "glm-4.5-flash",        // GRÁTIS
  "glm-4-32b-0414-128k": "glm-4-32b-0414-128k",  // $0.10/MTok
  "glm-4.7-flashx":      "glm-4.7-flashx",       // $0.07/$0.40
  "glm-4.5-air":         "glm-4.5-air",           // $0.20/$1.10
  "glm-4.7":             "glm-4.7",               // $0.60/$2.20
  "glm-4.6":             "glm-4.6",               // $0.60/$2.20
  "glm-5":               "glm-5",                 // $1.00/$3.20
  "glm-5-turbo":         "glm-5-turbo",           // $1.20/$4.00
} as const;

export class ZaiProvider implements LLMProvider {
  readonly name = "zai";
  readonly model: string;
  private client: OpenAI;

  constructor(apiKey: string, model = "glm-4.7-flash") {
    this.model = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.z.ai/api/paas/v4/",
    });
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: buildUserPrompt(filePath, content) },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    return {
      analysis: parseAnalysisResponse(raw, filePath),
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
```

### 7.4 Factory (factory.ts)

```typescript
export type ProviderName = "anthropic" | "openai" | "deepseek" | "gemini" | "zai";

// Auto-detect priority: anthropic > deepseek > zai > openai > gemini
```

### 7.5 Model Discovery (model-discovery.ts)

Consulta `GET /models` de cada provider, cacheia 24h no SQLite (`models_cache`). Formatos:

- **OpenAI, DeepSeek, Z.AI:** OpenAI-compatible (`{ data: [{ id, owned_by }] }`)
- **Anthropic:** `GET /v1/models` com header `anthropic-version`, retorna `{ data: [{ id, capabilities }] }`
- **Gemini:** `GET /v1beta/models?key=` retorna `{ models: [{ name, supportedGenerationMethods }] }`

Fallback para hardcoded se fetch falhar.

---

## 8. Busca Semântica com Embeddings (Cloudflare Workers AI + Vectorize)

### 8.1 Conceito

Além do FTS5 (keyword match), o sistema gera embeddings vetoriais de summaries, comments de símbolos e conceitos. Isso permite buscas como "onde fica a lógica de retry do webhook?" mesmo que nenhum arquivo contenha a palavra "retry" literalmente.

Usa Cloudflare Workers AI para gerar embeddings e Cloudflare Vectorize como vector store — tudo incluso no plano Workers Paid ($5/mês) que o projeto já usa.

### 8.2 Por que Cloudflare ao invés de LanceDB ou OpenAI Embeddings?

| Aspecto | Cloudflare Workers AI + Vectorize | OpenAI + LanceDB |
|---|---|---|
| **Custo de embedding** | **$0.00** (10K neurons/dia grátis, `bge-m3` = 1,075 neurons/MTok → ~9.3M tokens/dia grátis) | $0.02/MTok |
| **Custo de vector storage** | **$0.00** (10M stored dims inclusos no plano $5 → ~9,700 vetores de 1024 dims) | $0.00 (local) |
| **Custo de queries** | **$0.00** (50M queried dims/mês inclusos → ~48K queries/mês) | $0.00 (local) |
| **Infraestrutura** | Já usa Cloudflare (Workers, R2, KV) — zero infra nova | LanceDB roda local, zero-config |
| **Latência de busca** | ~10-50ms (edge, globalmente) | ~1-5ms (local, SSD) |
| **Requer internet** | Sim (para embed + search) | Não |
| **Qualidade do embedding** | `bge-m3`: SOTA multi-lingual, 1024 dims | `text-embedding-3-small`: 1536 dims |

**Decisão:** Para o ZapCode, Cloudflare é a escolha óbvia. Custo zero, stack que já existe, e `bge-m3` tem qualidade excelente para código (multi-lingual, cobre PT-BR nos comentários).

**Fallback:** Se offline ou se Cloudflare estiver inacessível, o sistema degrada gracefully para FTS5-only (sem busca semântica).

### 8.3 Arquitetura: Worker Proxy

O indexador roda local (CLI/MCP Server) mas precisa de um Worker na Cloudflare como proxy para acessar Workers AI e Vectorize:

```
Local (CLI / MCP Server)                    Cloudflare Edge
┌──────────────────────┐                   ┌───────────────────────────┐
│ IndexAgent           │                   │ mcp-indexer-worker        │
│  ├── Analisa arquivo │                   │  (Cloudflare Worker)      │
│  │   (LLM provider)  │                   │                           │
│  ├── Gera texto para │──── POST /embed ──│──▶ Workers AI (bge-m3)   │
│  │   embedding       │                   │      ↓ vector             │
│  ├── Recebe vector   │◄── { vector } ────│                           │
│  └── Envia para      │                   │                           │
│      armazenar       │── POST /upsert ──▶│──▶ Vectorize (index)     │
│                      │                   │                           │
│ HybridSearch         │                   │                           │
│  ├── FTS5 (local)    │                   │                           │
│  ├── Vector search   │── POST /search ──▶│──▶ Vectorize.query()     │
│  │   (Cloudflare)    │◄── [results] ─────│                           │
│  └── RRF merge       │                   │                           │
└──────────────────────┘                   └───────────────────────────┘
```

### 8.4 Worker Proxy (mcp-indexer-worker)

Um Worker simples deployado na Cloudflare que expõe 3 endpoints:

```typescript
// wrangler.jsonc
{
  "name": "mcp-indexer-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-09-23",
  "ai": { "binding": "AI" },
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": "code-index" }
  ]
}
```

```typescript
// src/index.ts — Worker proxy
export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  AUTH_TOKEN: string;  // shared secret para autenticar requests do CLI
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Validar auth
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);

    // POST /embed — gerar embeddings
    if (url.pathname === "/embed" && request.method === "POST") {
      const { texts } = await request.json() as { texts: string[] };
      const response = await env.AI.run("@cf/baai/bge-m3", { text: texts });
      return Response.json({ vectors: response.data, count: texts.length });
    }

    // POST /upsert — inserir/atualizar vetores no Vectorize
    if (url.pathname === "/upsert" && request.method === "POST") {
      const { vectors } = await request.json() as {
        vectors: Array<{ id: string; values: number[]; metadata: Record<string, string> }>
      };
      const inserted = await env.VECTORIZE.upsert(vectors);
      return Response.json({ count: inserted.count });
    }

    // POST /search — buscar no Vectorize
    if (url.pathname === "/search" && request.method === "POST") {
      const { vector, topK, filter } = await request.json() as {
        vector: number[];
        topK: number;
        filter?: Record<string, string>;
      };
      const results = await env.VECTORIZE.query(vector, {
        topK: topK || 20,
        returnMetadata: "all",
        filter,
      });
      return Response.json({ matches: results.matches });
    }

    // POST /delete — deletar vetores por prefixo de ID
    if (url.pathname === "/delete" && request.method === "POST") {
      const { ids } = await request.json() as { ids: string[] };
      const deleted = await env.VECTORIZE.deleteByIds(ids);
      return Response.json({ count: deleted.count });
    }

    // GET /health
    if (url.pathname === "/health") {
      return Response.json({ ok: true, timestamp: Date.now() });
    }

    return new Response("Not Found", { status: 404 });
  }
};
```

### 8.5 Setup do Vectorize Index

```bash
# Criar index com wrangler (uma vez)
npx wrangler vectorize create code-index \
  --dimensions=1024 \
  --metric=cosine

# O index suporta metadata filtering:
# - project_name (string)
# - type ("file" | "symbol")
# - language (string)
# - kind (string) — para symbols
```

### 8.6 Embedding Service (src/search/embeddings.ts)

```typescript
export interface EmbeddingService {
  embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>;
  embedQuery(text: string): Promise<{ vector: number[]; tokens: number }>;
}

export class CloudflareEmbeddingService implements EmbeddingService {
  private workerUrl: string;
  private authToken: string;

  constructor(workerUrl?: string, authToken?: string) {
    this.workerUrl = workerUrl
      ?? process.env.MCP_INDEX_WORKER_URL
      ?? "https://mcp-indexer-worker.<account>.workers.dev";
    this.authToken = authToken
      ?? process.env.MCP_INDEX_WORKER_TOKEN
      ?? "";
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    // Batch em chunks de 100 (limite Workers AI)
    const allVectors: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await fetch(`${this.workerUrl}/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ texts: batch }),
      });

      if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
      const data = await res.json() as { vectors: number[][]; count: number };
      allVectors.push(...data.vectors);
      // Estimativa de tokens (Workers AI não retorna usage diretamente)
      totalTokens += batch.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    }

    return { vectors: allVectors, tokens: totalTokens };
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    const result = await this.embed([text]);
    return { vector: result.vectors[0], tokens: result.tokens };
  }
}

// Fallback: null embedding service (quando offline, desabilita busca semântica)
export class NullEmbeddingService implements EmbeddingService {
  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    return { vectors: [], tokens: 0 };
  }
  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    return { vector: [], tokens: 0 };
  }
}
```

### 8.7 Vector Store (src/store/vectors.ts)

```typescript
export interface VectorRecord {
  id: string;           // "file:{project}:{path}" ou "sym:{project}:{id}"
  values: number[];     // embedding 1024 dims
  metadata: {
    project_name: string;
    type: "file" | "symbol";
    ref_id: string;       // files.id ou symbols.id
    text: string;         // texto original (truncado a 1000 chars para metadata)
    language?: string;
    kind?: string;        // para symbols
    path?: string;
  };
}

export class CloudflareVectorStore {
  private workerUrl: string;
  private authToken: string;

  constructor(workerUrl?: string, authToken?: string) {
    this.workerUrl = workerUrl ?? process.env.MCP_INDEX_WORKER_URL ?? "";
    this.authToken = authToken ?? process.env.MCP_INDEX_WORKER_TOKEN ?? "";
  }

  private async request(path: string, body: any): Promise<any> {
    const res = await fetch(`${this.workerUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Vector store error: ${res.status}`);
    return res.json();
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    // Batch de até 1000 por chamada (limite Vectorize)
    for (let i = 0; i < records.length; i += 1000) {
      const batch = records.slice(i, i + 1000);
      await this.request("/upsert", { vectors: batch });
    }
  }

  async search(
    queryVector: number[],
    options?: {
      topK?: number;
      projectName?: string;
      type?: "file" | "symbol";
    }
  ): Promise<Array<{ id: string; score: number; metadata: VectorRecord["metadata"] }>> {
    const filter: Record<string, string> = {};
    if (options?.projectName) filter.project_name = options.projectName;
    if (options?.type) filter.type = options.type;

    const data = await this.request("/search", {
      vector: queryVector,
      topK: options?.topK ?? 20,
      filter: Object.keys(filter).length ? filter : undefined,
    });

    return data.matches.map((m: any) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata,
    }));
  }

  async deleteByProject(projectName: string): Promise<void> {
    // Vectorize não suporta delete by filter diretamente.
    // Workaround: o CLI mantém lista de IDs no SQLite e deleta por IDs.
    // Ver seção 8.9 para detalhes.
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.request("/delete", { ids: ids.slice(i, i + 1000) });
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.workerUrl}/health`, {
        headers: { "Authorization": `Bearer ${this.authToken}` },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

### 8.8 Hybrid Search (src/search/hybrid.ts)

Combina FTS5 (local) + Vectorize (Cloudflare) usando **Reciprocal Rank Fusion (RRF)**:

```typescript
export interface HybridSearchResult {
  id: number;
  type: "file" | "symbol";
  score: number;               // RRF score combinado
  fts_rank: number | null;
  vector_rank: number | null;
  data: DBFile | DBSymbol;
}

export class HybridSearch {
  constructor(
    private db: CodeIndexDB,
    private vectors: CloudflareVectorStore,
    private embeddings: EmbeddingService
  ) {}

  async search(
    projectId: number,
    projectName: string,
    query: string,
    options?: { limit?: number; type?: "file" | "symbol"; mode?: "fts" | "vector" | "hybrid" }
  ): Promise<HybridSearchResult[]> {
    const limit = options?.limit ?? 20;
    const mode = options?.mode ?? "hybrid";

    // FTS5 keyword search (sempre local, sempre rápido)
    const ftsResults = (mode === "fts" || mode === "hybrid")
      ? (options?.type === "symbol"
          ? this.db.searchSymbols(projectId, query, limit * 3)
          : this.db.searchFiles(projectId, query, limit * 3))
      : [];

    // Vector search (Cloudflare, pode falhar se offline)
    let vectorResults: Array<{ id: string; score: number; metadata: any }> = [];
    if (mode === "vector" || mode === "hybrid") {
      try {
        const { vector } = await this.embeddings.embedQuery(query);
        if (vector.length > 0) {
          vectorResults = await this.vectors.search(vector, {
            topK: limit * 3,
            projectName,
            type: options?.type,
          });
        }
      } catch (err) {
        // Cloudflare offline — degrada para FTS-only silenciosamente
        console.warn("Vector search unavailable, using FTS only:", err);
      }
    }

    if (mode === "fts") return this.formatFtsOnly(ftsResults, limit);
    if (mode === "vector") return this.formatVectorOnly(vectorResults, limit);

    // Hybrid: Reciprocal Rank Fusion
    const K = 60;
    const scoreMap = new Map<string, {
      score: number; fts_rank: number | null; vector_rank: number | null; data: any
    }>();

    ftsResults.forEach((item: any, rank: number) => {
      const key = `${item.id}`;
      const existing = scoreMap.get(key) || { score: 0, fts_rank: null, vector_rank: null, data: item };
      existing.score += 1 / (K + rank + 1);
      existing.fts_rank = rank + 1;
      scoreMap.set(key, existing);
    });

    vectorResults.forEach((item, rank) => {
      const key = item.metadata?.ref_id ?? item.id;
      const existing = scoreMap.get(key) || { score: 0, fts_rank: null, vector_rank: null, data: null };
      existing.score += 1 / (K + rank + 1);
      existing.vector_rank = rank + 1;
      if (!existing.data) {
        existing.data = item.metadata?.type === "file"
          ? this.db.getFileById(parseInt(key))
          : this.db.getSymbolById(parseInt(key));
      }
      scoreMap.set(key, existing);
    });

    return Array.from(scoreMap.values())
      .filter(r => r.data)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => ({
        id: r.data.id,
        type: options?.type ?? (r.data.file_path ? "symbol" : "file"),
        score: r.score,
        fts_rank: r.fts_rank,
        vector_rank: r.vector_rank,
        data: r.data,
      }));
  }
}
```

### 8.9 Gerenciamento de IDs de Vetores

Como Vectorize não suporta "delete by metadata filter", o sistema mantém uma tabela auxiliar no SQLite para rastrear quais vector IDs pertencem a cada projeto:

```sql
CREATE TABLE IF NOT EXISTS vector_ids (
  id          TEXT    PRIMARY KEY,       -- "file:zapcode-api:src/index.ts"
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,          -- "file" | "symbol"
  ref_id      INTEGER NOT NULL           -- files.id ou symbols.id
);
CREATE INDEX IF NOT EXISTS idx_vid_project ON vector_ids(project_id);
```

Ao deletar um projeto ou re-indexar:
1. Busca IDs na tabela `vector_ids` por `project_id`
2. Chama `deleteByIds(ids)` no Vectorize
3. Remove da tabela `vector_ids`

### 8.10 Textos para Embedding

Para cada **arquivo**:
```
File: {path}
Language: {language}
Summary: {summary}
Concepts: {concepts.join(", ")}
Dependencies: {internal_deps.join(", ")}
Symbols: {symbols.map(s => `${s.kind} ${s.name}: ${s.comment}`).join("\n")}
```

Para cada **símbolo** relevante (classes, funções com 2+ linhas de comment):
```
{kind} {name} in {file_path}
Signature: {signature}
Description: {comment}
Tags: {tags.join(", ")}
```

### 8.11 Vectorize Metadata Schema

Cada vetor no Vectorize tem estes campos de metadata (usados para filtering):

```typescript
{
  project_name: string;    // filtro por projeto
  type: "file" | "symbol"; // filtro por tipo
  ref_id: string;          // ID no SQLite para join
  text: string;            // texto original (max 1000 chars)
  language: string;        // "typescript", "php", etc.
  kind: string;            // "class", "function" (só para symbols)
  path: string;            // caminho do arquivo
}
```

### 8.12 Cálculo de Consumo no Plano $5

Para um cenário realista (5 projetos, 500 arquivos cada, 100 queries/dia):

| Recurso | Consumo | Incluso no plano | % usado |
|---|---|---|---|
| **Embedding neurons** | 2,500 files × 300 tok avg × 1,075 neurons/MTok = ~807 neurons | 10,000/dia | 8% |
| **Stored dims** | 2,500 vetores × 1024 dims = 2.56M | 10M | 25% |
| **Queried dims** | 100 queries/dia × 30 × 1024 = 3.07M | 50M/mês | 6% |

**Sobra de neurons para LLM no Workers AI:** Com 807 neurons gastos em embeddings, sobram ~9,193 neurons/dia. Isso dá pra rodar `@cf/meta/llama-3.2-3b-instruct` como provider de análise local se quiser — ~200 arquivos/dia com Llama 3.2 3B (grátis).

### 8.13 Pipeline de Indexação Atualizado (com Cloudflare)

1. FileScanner detecta arquivos alterados (SHA256)
2. LLM analisa cada arquivo → `LLMFileAnalysis` (via provider escolhido)
3. Salva no SQLite (files + symbols + FTS5)
4. Gera textos de embedding para arquivos e símbolos alterados
5. Chama Worker proxy `POST /embed` com textos em batch (100 por chamada)
6. Recebe vetores de volta
7. Chama Worker proxy `POST /upsert` com vetores + metadata
8. Salva IDs na tabela `vector_ids` para tracking
9. Registra custos (tokens de análise + neurons estimados de embedding)

### 8.14 Variáveis de Ambiente Adicionais

| Variável | Descrição |
|---|---|
| `MCP_INDEX_WORKER_URL` | URL do Worker proxy (ex: `https://mcp-indexer-worker.maicon.workers.dev`) |
| `MCP_INDEX_WORKER_TOKEN` | Token compartilhado para autenticação no Worker |
| `MCP_INDEX_EMBEDDINGS` | `true`/`false` — habilitar embeddings (default: `true`) |

### 8.15 Graceful Degradation

Se o Worker proxy estiver inacessível (sem internet, Worker em deploy, etc.):
- `isAvailable()` retorna `false` (timeout 3s)
- `HybridSearch` degrada automaticamente para FTS5-only
- Indexação continua normalmente (só salva no SQLite, pula embeddings)
- Na próxima indexação com Cloudflare disponível, gera embeddings para todos os arquivos que ainda não têm vetores

---

## 9. Context Snapshots (Memória de Projeto)

### 9.1 Conceito

Snapshots são notas persistentes sobre o projeto — decisões de arquitetura, padrões adotados, convenções, TODOs estratégicos. O Claude Code pode consultar e criar snapshots, criando uma "memória de projeto" entre sessões.

### 9.2 Tabela `snapshots`

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'note',
    -- architecture | decision | pattern | convention | todo | note
  content       TEXT    NOT NULL,            -- markdown
  tags          TEXT    NOT NULL DEFAULT '[]', -- JSON array
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  created_by    TEXT    NOT NULL DEFAULT 'user'  -- user | auto | claude
);

CREATE INDEX IF NOT EXISTS idx_snap_project ON snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_snap_category ON snapshots(category);
```

### 9.3 Service (src/services/snapshots.ts)

```typescript
export class SnapshotService {
  create(projectId: number, snapshot: Partial<ContextSnapshot>): ContextSnapshot;
  update(id: number, updates: Partial<ContextSnapshot>): ContextSnapshot;
  delete(id: number): void;
  list(projectId: number, category?: string): ContextSnapshot[];
  search(projectId: number, query: string): ContextSnapshot[];  // FTS ou LIKE
  getForContext(projectId: number): string;  // retorna markdown formatado de TODOS os snapshots para injetar como contexto
}
```

### 9.4 Método `getForContext()`

Gera um bloco de texto formatado que o MCP Server pode retornar ao Claude Code como contexto do projeto:

```markdown
## Project Context: zapcode-api

### Architecture Decisions
- **2024-12: Migração Docker → Podman** — Todos os containers usam Podman com rootless. WebSocket proxy via Apache `mod_proxy_wstunnel`.
- **2025-01: Supabase self-hosted** — Supavisor como connection pooler. Multi-tenant via `search_path` por role.

### Conventions
- Rotas API seguem padrão `/api/v1/{resource}`.
- Erros retornam `{ error: string, code: string }`.
- Workers Cloudflare usam KV para cache de tokens.

### Patterns
- Observer pattern para eventos de webhook.
- State machine para fluxo de agendamento (Agenda).
```

### 9.5 MCP Tools

| Tool | Input | Descrição |
|---|---|---|
| `add_snapshot` | `project_name`, `title`, `category`, `content`, `tags?` | Cria snapshot |
| `list_snapshots` | `project_name`, `category?` | Lista snapshots |
| `get_project_context` | `project_name` | Retorna TODOS os snapshots formatados como contexto |
| `update_snapshot` | `id`, `content?`, `title?`, `tags?` | Atualiza snapshot |
| `delete_snapshot` | `id` | Remove snapshot |

### 9.6 Auto-snapshots

O indexador pode gerar snapshots automáticos ao detectar padrões:

- Primeira indexação: gera snapshot "Project Overview" com summary do projeto
- Mudanças significativas: gera snapshot "Architecture Change" quando conceitos novos surgem
- `created_by: "auto"` para diferenciar de snapshots manuais

---

## 10. File Watcher (Daemon)

### 10.1 Conceito

Modo daemon que monitora o diretório do projeto e re-indexa automaticamente quando arquivos mudam. Usa `chokidar` com debounce.

### 10.2 Service (src/services/watcher.ts)

```typescript
import chokidar from "chokidar";

export interface WatcherConfig {
  projectId: number;
  rootPath: string;
  debounceMs: number;         // default: 2000
  autoIndex: boolean;         // default: true
  ignore: string[];           // patterns extras
}

export interface WatcherEvents {
  onFileChanged(files: string[]): void;
  onIndexStart(runId: number): void;
  onIndexComplete(result: IndexResult): void;
  onError(error: Error): void;
}

export class FileWatcherService {
  private watchers: Map<number, chokidar.FSWatcher> = new Map();
  private pendingChanges: Map<number, Set<string>> = new Map();
  private debounceTimers: Map<number, NodeJS.Timeout> = new Map();

  /**
   * Inicia watch para um projeto.
   */
  startWatching(config: WatcherConfig, events: WatcherEvents): void {
    if (this.watchers.has(config.projectId)) {
      this.stopWatching(config.projectId);
    }

    const ignored = [
      "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
      ...config.ignore,
    ];

    const watcher = chokidar.watch(config.rootPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    const onChange = (filePath: string) => {
      // Acumula mudanças
      if (!this.pendingChanges.has(config.projectId)) {
        this.pendingChanges.set(config.projectId, new Set());
      }
      this.pendingChanges.get(config.projectId)!.add(filePath);

      // Debounce: espera N ms após última mudança antes de re-indexar
      if (this.debounceTimers.has(config.projectId)) {
        clearTimeout(this.debounceTimers.get(config.projectId)!);
      }

      this.debounceTimers.set(config.projectId, setTimeout(async () => {
        const files = Array.from(this.pendingChanges.get(config.projectId) || []);
        this.pendingChanges.delete(config.projectId);

        events.onFileChanged(files);

        if (config.autoIndex) {
          // Trigger re-indexação incremental
          // O indexer já compara hash, então só processa os realmente alterados
          try {
            const result = await runIndexer({ /* config */ });
            events.onIndexComplete(result);
          } catch (err) {
            events.onError(err as Error);
          }
        }
      }, config.debounceMs));
    };

    watcher
      .on("add", onChange)
      .on("change", onChange)
      .on("unlink", onChange);

    this.watchers.set(config.projectId, watcher);
  }

  stopWatching(projectId: number): void {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(projectId);
    }
    if (this.debounceTimers.has(projectId)) {
      clearTimeout(this.debounceTimers.get(projectId)!);
      this.debounceTimers.delete(projectId);
    }
  }

  stopAll(): void {
    for (const projectId of this.watchers.keys()) {
      this.stopWatching(projectId);
    }
  }

  isWatching(projectId: number): boolean {
    return this.watchers.has(projectId);
  }

  listWatching(): number[] {
    return Array.from(this.watchers.keys());
  }
}
```

### 10.3 CLI

```bash
# Watch um projeto (foreground, com output de progresso)
mcp-code-indexer watch zapcode-api

# Watch com opções
mcp-code-indexer watch zapcode-api --debounce=5000 --no-auto-index

# Watch múltiplos projetos
mcp-code-indexer watch zapcode-api zapcode-front

# Watch todos os projetos registrados
mcp-code-indexer watch --all

# Daemon mode (background via nohup ou systemd)
mcp-code-indexer watch --all --daemon --pid-file=/tmp/mcp-indexer.pid
```

### 10.4 Integração com Webhooks

Quando o watcher dispara re-indexação, envia evento `watch.changed` com lista de arquivos alterados, e `index.done` quando termina.

---

## 11. Webhooks

### 11.1 Tabela

```sql
CREATE TABLE IF NOT EXISTS webhooks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global
  url             TEXT    NOT NULL,
  events          TEXT    NOT NULL DEFAULT '[]',     -- JSON: ["index.done","index.failed","watch.changed"]
  secret          TEXT,                              -- HMAC-SHA256 signing secret
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL,
  last_triggered  TEXT,
  last_status     INTEGER                            -- HTTP status code
);
```

### 11.2 Eventos Suportados

| Evento | Quando | Payload extra |
|---|---|---|
| `index.start` | Início de indexação | `{ run_id, provider, model }` |
| `index.done` | Indexação completa | `{ run_id, indexed, skipped, errors, duration_ms, cost_usd }` |
| `index.failed` | Indexação falhou | `{ run_id, error }` |
| `watch.changed` | Watcher detectou mudanças | `{ files: string[], count }` |
| `snapshot.created` | Novo snapshot | `{ snapshot_id, title, category }` |

### 11.3 Dispatcher (src/services/webhooks.ts)

```typescript
export class WebhookDispatcher {
  constructor(private db: CodeIndexDB) {}

  async dispatch(event: string, project: Project, data: Record<string, any>): Promise<void> {
    const webhooks = this.db.getWebhooksForEvent(project.id, event);

    for (const webhook of webhooks) {
      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        project: { id: project.id, name: project.name, root_path: project.root_path },
        data,
      };

      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      // HMAC signing
      if (webhook.secret) {
        const { createHmac } = await import("crypto");
        const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");
        headers["X-Signature-256"] = `sha256=${signature}`;
      }

      try {
        const res = await fetch(webhook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
        this.db.updateWebhookStatus(webhook.id, res.status);
      } catch (err) {
        this.db.updateWebhookStatus(webhook.id, 0); // 0 = network error
      }
    }
  }
}
```

### 11.4 CLI e API

```bash
# CLI
mcp-code-indexer webhooks list
mcp-code-indexer webhooks add --project=zapcode-api --url=https://n8n.example.com/webhook/... --events=index.done,index.failed
mcp-code-indexer webhooks remove <id>
mcp-code-indexer webhooks test <id>     # dispara payload de teste

# API
POST   /api/webhooks                 → createWebhook({ project_id?, url, events, secret? })
GET    /api/webhooks                 → listWebhooks()
DELETE /api/webhooks/:id             → deleteWebhook(id)
POST   /api/webhooks/:id/test       → testWebhook(id)
```

---

## 12. Export (Documentação Automática)

### 12.1 Conceito

Gera documentação markdown do projeto a partir do index. Útil para onboarding, auditorias, ou como README técnico auto-gerado.

### 12.2 Service (src/services/exporter.ts)

```typescript
export class ExportService {
  constructor(private db: CodeIndexDB) {}

  async export(options: ExportOptions): Promise<string> {
    const project = this.db.getProject(options.project_id);
    const sections = options.sections;
    const parts: string[] = [];

    parts.push(`# ${project.name} — Code Documentation`);
    parts.push(`> Auto-generated by mcp-code-indexer on ${new Date().toISOString()}\n`);

    if (sections.includes("overview"))     parts.push(this.buildOverview(project));
    if (sections.includes("architecture")) parts.push(this.buildArchitecture(project));
    if (sections.includes("files"))        parts.push(this.buildFileIndex(project));
    if (sections.includes("symbols"))      parts.push(this.buildSymbolCatalog(project));
    if (sections.includes("concepts"))     parts.push(this.buildConceptMap(project));
    if (sections.includes("api"))          parts.push(this.buildAPIMap(project));
    if (sections.includes("snapshots") && options.include_snapshots) {
      parts.push(this.buildSnapshots(project));
    }
    if (sections.includes("changelog"))    parts.push(this.buildChangelog(project));

    const markdown = parts.join("\n\n---\n\n");

    // Salvar em arquivo
    const outputPath = options.output_path
      ?? path.join(os.homedir(), ".mcp-code-indexer", "exports", `${project.name}.md`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, markdown, "utf-8");

    return markdown;
  }

  private buildOverview(project: Project): string {
    const stats = this.db.getStats(project.id);
    const langs = Object.entries(stats.languages)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang} (${count} files)`)
      .join(", ");

    return `## Overview\n\n` +
      `- **Path:** \`${project.root_path}\`\n` +
      `- **Files:** ${stats.total_files}\n` +
      `- **Symbols:** ${stats.total_symbols}\n` +
      `- **Languages:** ${langs}\n` +
      `- **Last indexed:** ${project.last_indexed}\n` +
      (project.description ? `\n${project.description}\n` : "");
  }

  private buildArchitecture(project: Project): string {
    const files = this.db.listFiles(project.id);
    const concepts = this.db.listConcepts(project.id);

    // Agrupar por diretório de primeiro nível
    const dirs = new Map<string, DBFile[]>();
    for (const f of files) {
      const dir = f.path.split("/")[0] || ".";
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)!.push(f);
    }

    let md = "## Architecture\n\n### Directory Structure\n\n";
    for (const [dir, dirFiles] of dirs) {
      md += `#### \`${dir}/\`\n`;
      for (const f of dirFiles.slice(0, 10)) {
        md += `- \`${f.path}\` — ${f.summary}\n`;
      }
      if (dirFiles.length > 10) md += `- *... and ${dirFiles.length - 10} more*\n`;
      md += "\n";
    }

    md += "### Domain Concepts\n\n";
    for (const { concept, count } of concepts) {
      const conceptFiles = this.db.getFilesByConcept(project.id, concept);
      md += `- **${concept}** (${count} files): ${conceptFiles.map(f => `\`${f.path}\``).join(", ")}\n`;
    }

    return md;
  }

  private buildFileIndex(project: Project): string {
    const files = this.db.listFiles(project.id);
    let md = "## File Index\n\n";
    md += "| File | Language | Lines | Complexity | Summary |\n";
    md += "|------|----------|-------|------------|----------|\n";
    for (const f of files) {
      const summary = f.summary.length > 80 ? f.summary.slice(0, 77) + "..." : f.summary;
      md += `| \`${f.path}\` | ${f.language} | ${f.line_count} | ${f.complexity} | ${summary} |\n`;
    }
    return md;
  }

  private buildSymbolCatalog(project: Project): string {
    const symbols = this.db.listAllSymbols(project.id);
    const byKind = new Map<string, DBSymbol[]>();
    for (const s of symbols) {
      if (!byKind.has(s.kind)) byKind.set(s.kind, []);
      byKind.get(s.kind)!.push(s);
    }

    let md = "## Symbol Catalog\n\n";
    for (const [kind, syms] of byKind) {
      md += `### ${kind.charAt(0).toUpperCase() + kind.slice(1)}s (${syms.length})\n\n`;
      for (const s of syms) {
        md += `- **${s.name}**`;
        if (s.signature) md += ` — \`${s.signature}\``;
        if (s.comment) md += ` — ${s.comment}`;
        md += ` (\`${s.file_path}\`${s.line ? `:${s.line}` : ""})\n`;
      }
      md += "\n";
    }
    return md;
  }

  private buildAPIMap(project: Project): string {
    // Busca símbolos com tags "entry-point", "api-handler", "route", "endpoint"
    const apiSymbols = this.db.searchSymbols(project.id, "entry-point api-handler route endpoint", 100);
    if (!apiSymbols.length) return "";

    let md = "## API Map\n\n";
    for (const s of apiSymbols) {
      md += `- **${s.name}** (\`${s.kind}\`) in \`${s.file_path}\``;
      if (s.signature) md += `\n  - Signature: \`${s.signature}\``;
      if (s.comment) md += `\n  - ${s.comment}`;
      md += "\n";
    }
    return md;
  }

  private buildSnapshots(project: Project): string {
    const snapshots = this.db.listSnapshots(project.id);
    if (!snapshots.length) return "";

    let md = "## Project Context & Decisions\n\n";
    const byCategory = new Map<string, ContextSnapshot[]>();
    for (const s of snapshots) {
      if (!byCategory.has(s.category)) byCategory.set(s.category, []);
      byCategory.get(s.category)!.push(s);
    }

    for (const [cat, snaps] of byCategory) {
      md += `### ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n`;
      for (const s of snaps) {
        md += `#### ${s.title}\n${s.content}\n\n`;
      }
    }
    return md;
  }

  private buildChangelog(project: Project): string {
    // Diff entre últimos 2 runs
    const runs = this.db.getRuns(project.id, 2);
    if (runs.length < 2) return "";

    const diff = new DiffService(this.db).diff(project.id, runs[1].id, runs[0].id);
    let md = "## Recent Changes\n\n";
    md += `*Comparing run #${diff.run_before} → #${diff.run_after}*\n\n`;

    if (diff.files_added.length) {
      md += `### Files Added (${diff.files_added.length})\n`;
      for (const f of diff.files_added) md += `- \`${f.path}\` (${f.language}) — ${f.summary}\n`;
      md += "\n";
    }
    if (diff.files_removed.length) {
      md += `### Files Removed (${diff.files_removed.length})\n`;
      for (const f of diff.files_removed) md += `- \`${f.path}\`\n`;
      md += "\n";
    }
    if (diff.files_modified.length) {
      md += `### Files Modified (${diff.files_modified.length})\n`;
      for (const f of diff.files_modified) {
        md += `- \`${f.path}\``;
        if (f.symbols_added.length) md += ` — added: ${f.symbols_added.join(", ")}`;
        if (f.symbols_removed.length) md += ` — removed: ${f.symbols_removed.join(", ")}`;
        md += "\n";
      }
    }
    return md;
  }
}
```

### 12.3 CLI e MCP Tool

```bash
# CLI
mcp-code-indexer export zapcode-api                              # todas as seções
mcp-code-indexer export zapcode-api --sections=overview,architecture,api
mcp-code-indexer export zapcode-api --output=./docs/CODEBASE.md
mcp-code-indexer export zapcode-api --format=json                # JSON em vez de markdown
mcp-code-indexer export zapcode-api --include-snapshots --include-costs

# MCP Tool
export_docs { project_name, sections?, output_path?, include_snapshots? }
```

---

## 13. Diff de Versões

### 13.1 Conceito

Compara o estado do index entre dois runs (ou entre o último run e o estado atual) para ver o que mudou: arquivos adicionados, removidos, modificados; símbolos adicionados/removidos; conceitos novos/removidos.

### 13.2 Tabela `file_snapshots`

Armazena o estado de cada arquivo em cada run para comparação posterior:

```sql
CREATE TABLE IF NOT EXISTS file_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL,
  path        TEXT    NOT NULL,
  content_hash TEXT   NOT NULL,
  summary     TEXT    NOT NULL DEFAULT '',
  concepts    TEXT    NOT NULL DEFAULT '[]',
  symbols_json TEXT   NOT NULL DEFAULT '[]',   -- JSON: [{ name, kind, signature }]
  UNIQUE(run_id, path)
);

CREATE INDEX IF NOT EXISTS idx_fsnap_run ON file_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_fsnap_project ON file_snapshots(project_id);
```

O indexador salva automaticamente um snapshot de cada arquivo processado no final de cada run.

### 13.3 Service (src/services/differ.ts)

```typescript
export class DiffService {
  constructor(private db: CodeIndexDB) {}

  /**
   * Compara dois runs do mesmo projeto.
   */
  diff(projectId: number, runBefore: number, runAfter: number): RunDiff {
    const before = this.db.getFileSnapshots(runBefore);
    const after = this.db.getFileSnapshots(runAfter);

    const beforeMap = new Map(before.map(f => [f.path, f]));
    const afterMap = new Map(after.map(f => [f.path, f]));

    const filesAdded: DiffFileEntry[] = [];
    const filesRemoved: DiffFileEntry[] = [];
    const filesModified: DiffFileModified[] = [];

    // Arquivos novos
    for (const [path, f] of afterMap) {
      if (!beforeMap.has(path)) {
        filesAdded.push({ path, language: "", summary: f.summary });
      }
    }

    // Arquivos removidos
    for (const [path, f] of beforeMap) {
      if (!afterMap.has(path)) {
        filesRemoved.push({ path, language: "", summary: f.summary });
      }
    }

    // Arquivos modificados (hash mudou)
    for (const [path, fAfter] of afterMap) {
      const fBefore = beforeMap.get(path);
      if (fBefore && fBefore.content_hash !== fAfter.content_hash) {
        const symsBefore = JSON.parse(fBefore.symbols_json) as { name: string; kind: string }[];
        const symsAfter = JSON.parse(fAfter.symbols_json) as { name: string; kind: string }[];

        const beforeNames = new Set(symsBefore.map(s => s.name));
        const afterNames = new Set(symsAfter.map(s => s.name));

        const conceptsBefore = JSON.parse(fBefore.concepts) as string[];
        const conceptsAfter = JSON.parse(fAfter.concepts) as string[];

        filesModified.push({
          path,
          language: "",
          summary_before: fBefore.summary,
          summary_after: fAfter.summary,
          symbols_added: symsAfter.filter(s => !beforeNames.has(s.name)).map(s => s.name),
          symbols_removed: symsBefore.filter(s => !afterNames.has(s.name)).map(s => s.name),
          concepts_changed: {
            added: conceptsAfter.filter(c => !conceptsBefore.includes(c)),
            removed: conceptsBefore.filter(c => !conceptsAfter.includes(c)),
          },
        });
      }
    }

    // Símbolos agregados
    const allSymsBefore = before.flatMap(f => JSON.parse(f.symbols_json));
    const allSymsAfter = after.flatMap(f => JSON.parse(f.symbols_json));
    const symNamesBefore = new Set(allSymsBefore.map((s: any) => `${s.kind}:${s.name}`));
    const symNamesAfter = new Set(allSymsAfter.map((s: any) => `${s.kind}:${s.name}`));

    // Conceitos agregados
    const conceptsBefore = new Set(before.flatMap(f => JSON.parse(f.concepts)));
    const conceptsAfter = new Set(after.flatMap(f => JSON.parse(f.concepts)));

    return {
      run_before: runBefore,
      run_after: runAfter,
      files_added: filesAdded,
      files_removed: filesRemoved,
      files_modified: filesModified,
      symbols_added: allSymsAfter
        .filter((s: any) => !symNamesBefore.has(`${s.kind}:${s.name}`))
        .map((s: any) => ({ name: s.name, kind: s.kind, file_path: s.file_path || "", signature: s.signature || "" })),
      symbols_removed: allSymsBefore
        .filter((s: any) => !symNamesAfter.has(`${s.kind}:${s.name}`))
        .map((s: any) => ({ name: s.name, kind: s.kind, file_path: s.file_path || "", signature: s.signature || "" })),
      concepts_added: Array.from(conceptsAfter).filter(c => !conceptsBefore.has(c)),
      concepts_removed: Array.from(conceptsBefore).filter(c => !conceptsAfter.has(c)),
      summary: "", // preenchido pelo caller se quiser
    };
  }

  /**
   * Diff entre o último run e o penúltimo.
   */
  diffLatest(projectId: number): RunDiff | null {
    const runs = this.db.getRuns(projectId, 2);
    if (runs.length < 2) return null;
    return this.diff(projectId, runs[1].id, runs[0].id);
  }

  /**
   * Formato de texto legível para o Claude Code.
   */
  formatDiff(diff: RunDiff): string {
    const lines: string[] = [];
    lines.push(`Diff: Run #${diff.run_before} → #${diff.run_after}`);
    lines.push(`  +${diff.files_added.length} files added`);
    lines.push(`  -${diff.files_removed.length} files removed`);
    lines.push(`  ~${diff.files_modified.length} files modified`);
    lines.push(`  +${diff.symbols_added.length} symbols added`);
    lines.push(`  -${diff.symbols_removed.length} symbols removed`);

    if (diff.concepts_added.length)
      lines.push(`  New concepts: ${diff.concepts_added.join(", ")}`);
    if (diff.concepts_removed.length)
      lines.push(`  Removed concepts: ${diff.concepts_removed.join(", ")}`);

    if (diff.files_added.length) {
      lines.push("\nFiles Added:");
      for (const f of diff.files_added) lines.push(`  + ${f.path} — ${f.summary}`);
    }
    if (diff.files_removed.length) {
      lines.push("\nFiles Removed:");
      for (const f of diff.files_removed) lines.push(`  - ${f.path}`);
    }
    if (diff.files_modified.length) {
      lines.push("\nFiles Modified:");
      for (const f of diff.files_modified) {
        lines.push(`  ~ ${f.path}`);
        if (f.symbols_added.length) lines.push(`    + ${f.symbols_added.join(", ")}`);
        if (f.symbols_removed.length) lines.push(`    - ${f.symbols_removed.join(", ")}`);
      }
    }

    return lines.join("\n");
  }
}
```

### 13.4 CLI e MCP

```bash
# CLI
mcp-code-indexer diff zapcode-api                    # último vs penúltimo run
mcp-code-indexer diff zapcode-api --run-before=5 --run-after=8
mcp-code-indexer diff zapcode-api --format=json

# MCP Tool
get_diff { project_name, run_before?, run_after? }
```

---

## 14. Cost Tracking

### 14.1 Conceito

Rastreia tokens consumidos (input, output, embedding) e estima custo em USD por run, por projeto, por provider. Permite acompanhar o investimento em indexação.

### 14.2 Tabela `costs`

```sql
CREATE TABLE IF NOT EXISTS costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider      TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  operation     TEXT    NOT NULL,              -- "analysis" | "embedding"
  file_path     TEXT,                          -- NULL para embeddings em batch
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);
CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);
CREATE INDEX IF NOT EXISTS idx_costs_date ON costs(created_at);
```

### 14.3 Pricing Table (hardcoded com override por config)

```typescript
export const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic (por 1M tokens)
  "claude-haiku-4-5-20251001":   { input: 0.80,  output: 4.00 },
  "claude-sonnet-4-5-20250929":  { input: 3.00,  output: 15.00 },
  "claude-opus-4-5":             { input: 15.00, output: 75.00 },

  // OpenAI
  "gpt-4o-mini":   { input: 0.15,  output: 0.60 },
  "gpt-4o":        { input: 2.50,  output: 10.00 },

  // DeepSeek
  "deepseek-chat":     { input: 0.14,  output: 0.28 },
  "deepseek-reasoner": { input: 0.55,  output: 2.19 },

  // Gemini
  "gemini-2.0-flash":      { input: 0.10,  output: 0.40 },
  "gemini-2.0-flash-lite": { input: 0.0,   output: 0.0 },  // free tier
  "gemini-1.5-flash":      { input: 0.075, output: 0.30 },

  // Z.AI
  "glm-4.7-flash":       { input: 0.0,   output: 0.0 },  // grátis
  "glm-4.5-flash":       { input: 0.0,   output: 0.0 },  // grátis
  "glm-4-32b-0414-128k": { input: 0.10,  output: 0.10 },
  "glm-4.7":             { input: 0.60,  output: 2.20 },
  "glm-5":               { input: 1.00,  output: 3.20 },
  "glm-5-turbo":         { input: 1.20,  output: 4.00 },

  // Embeddings (Cloudflare Workers AI — grátis nos 10K neurons/dia)
  "@cf/baai/bge-m3":            { input: 0.012, output: 0.0 },  // $0.012/MTok, mas grátis no plano
  "@cf/baai/bge-small-en-v1.5": { input: 0.020, output: 0.0 },
  // Fallback OpenAI (caso use sem Cloudflare)
  "text-embedding-3-small": { input: 0.02, output: 0.0 },
  "text-embedding-3-large": { input: 0.13, output: 0.0 },
};
```

### 14.4 CostTracker (src/services/costs.ts)

```typescript
export class CostTracker {
  constructor(private db: CodeIndexDB) {}

  /**
   * Registra custo de uma operação.
   */
  record(params: {
    projectId: number;
    runId: number;
    provider: string;
    model: string;
    operation: "analysis" | "embedding";
    filePath?: string;
    inputTokens: number;
    outputTokens: number;
  }): void {
    const pricing = PRICING[params.model] || { input: 0, output: 0 };
    const costUsd =
      (params.inputTokens * pricing.input / 1_000_000) +
      (params.outputTokens * pricing.output / 1_000_000);

    this.db.insertCost({
      project_id: params.projectId,
      run_id: params.runId,
      provider: params.provider,
      model: params.model,
      operation: params.operation,
      file_path: params.filePath ?? null,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cost_usd: costUsd,
      created_at: new Date().toISOString(),
    });
  }

  /**
   * Summary de custos para um projeto.
   */
  getProjectCosts(projectId: number, since?: string): CostSummary {
    return this.db.getCostSummary(projectId, since);
  }

  /**
   * Summary global (todos os projetos).
   */
  getGlobalCosts(since?: string): CostSummary {
    return this.db.getGlobalCostSummary(since);
  }

  /**
   * Custo de um run específico.
   */
  getRunCost(runId: number): { input_tokens: number; output_tokens: number; embedding_tokens: number; cost_usd: number } {
    return this.db.getRunCostSummary(runId);
  }

  /**
   * Estimativa de custo ANTES de indexar (baseado no número de arquivos e tamanho médio).
   */
  estimateCost(params: {
    fileCount: number;
    avgFileSizeTokens: number;
    provider: string;
    model: string;
    embeddingsEnabled: boolean;
  }): { estimated_analysis_cost: number; estimated_embedding_cost: number; total: number } {
    const pricing = PRICING[params.model] || { input: 0, output: 0 };
    const totalInputTokens = params.fileCount * (params.avgFileSizeTokens + 500); // +500 for system prompt
    const totalOutputTokens = params.fileCount * 800; // ~800 tokens avg output per file

    const analysisCost =
      (totalInputTokens * pricing.input / 1_000_000) +
      (totalOutputTokens * pricing.output / 1_000_000);

    let embeddingCost = 0;
    if (params.embeddingsEnabled) {
      const embeddingTokens = params.fileCount * 300; // ~300 tokens per file embedding text
      const embPricing = PRICING["text-embedding-3-small"];
      embeddingCost = embeddingTokens * embPricing.input / 1_000_000;
    }

    return {
      estimated_analysis_cost: analysisCost,
      estimated_embedding_cost: embeddingCost,
      total: analysisCost + embeddingCost,
    };
  }
}
```

### 14.5 Integração no Pipeline

O indexador agora chama `costTracker.record()` após cada chamada de LLM e após cada batch de embeddings:

```typescript
// No loop de indexação:
const result = await provider.analyzeFile(filePath, content);
costTracker.record({
  projectId, runId, provider: provider.name, model: provider.model,
  operation: "analysis", filePath,
  inputTokens: result.usage.input_tokens,
  outputTokens: result.usage.output_tokens,
});

// Após batch de embeddings:
const embResult = await embeddingService.embed(texts);
costTracker.record({
  projectId, runId, provider: "openai", model: "text-embedding-3-small",
  operation: "embedding",
  inputTokens: embResult.tokens, outputTokens: 0,
});
```

### 14.6 CLI e API

```bash
# CLI
mcp-code-indexer costs                               # custos globais
mcp-code-indexer costs zapcode-api                   # custos por projeto
mcp-code-indexer costs --since=2025-01-01            # desde uma data
mcp-code-indexer costs --run=42                      # custo de um run específico
mcp-code-indexer costs estimate zapcode-api --provider=zai --model=glm-5  # estimativa antes de indexar

# API
GET /api/costs                                       → getGlobalCosts(since?)
GET /api/projects/:id/costs                          → getProjectCosts(id, since?)
GET /api/runs/:id/costs                              → getRunCost(id)
POST /api/projects/:id/costs/estimate                → estimateCost({ provider, model })
```

### 14.7 Output de exemplo

```
💰 Cost Summary — zapcode-api

  Total:           $0.0342
  Analysis:        $0.0317 (input: 85,420 tok + output: 12,300 tok)
  Embeddings:      $0.0025 (42,000 tok)

  By Provider:
    deepseek       $0.0217  (3 runs)
    zai            $0.0100  (2 runs, glm-4.7-flash = FREE)
    openai         $0.0025  (embeddings only)

  By Run:
    #12 (Mar 07)   $0.0142  deepseek-chat, 150 files
    #13 (Mar 10)   $0.0100  glm-5, 85 files (incremental)
    #14 (Mar 15)   $0.0075  deepseek-chat, 42 files (incremental)
    #15 (Mar 20)   $0.0025  glm-4.7-flash, 30 files (FREE + embeddings)
```

---

## 15. Schema SQL Completo (consolidado)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA foreign_keys = ON;

-- ═══ PROJECTS ═══
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  root_path     TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  provider      TEXT,
  model         TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  last_indexed  TEXT,
  file_count    INTEGER NOT NULL DEFAULT 0,
  symbol_count  INTEGER NOT NULL DEFAULT 0
);

-- ═══ FILES ═══
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path          TEXT    NOT NULL,
  language      TEXT    NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  line_count    INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT    NOT NULL,
  indexed_at    TEXT    NOT NULL,
  summary       TEXT    NOT NULL DEFAULT '',
  concepts      TEXT    NOT NULL DEFAULT '[]',
  dependencies  TEXT    NOT NULL DEFAULT '[]',
  internal_deps TEXT    NOT NULL DEFAULT '[]',
  notes         TEXT    NOT NULL DEFAULT '[]',
  complexity    TEXT    NOT NULL DEFAULT 'low',
  fts_content   TEXT    NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_project_path ON files(project_id, path);

-- ═══ SYMBOLS ═══
CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  signature   TEXT    NOT NULL DEFAULT '',
  parent      TEXT,
  modifiers   TEXT    NOT NULL DEFAULT '[]',
  return_type TEXT,
  parameters  TEXT,
  line        INTEGER,
  comment     TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_sym_project ON symbols(project_id);
CREATE INDEX IF NOT EXISTS idx_sym_name    ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_kind    ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_sym_file    ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_sym_parent  ON symbols(parent);

-- ═══ FTS5 ═══
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, kind, signature, comment, tags, file_path, parent,
  content=symbols, content_rowid=id,
  tokenize="unicode61 remove_diacritics 1"
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path, summary, concepts, fts_content,
  content=files, content_rowid=id,
  tokenize="unicode61 remove_diacritics 1"
);
-- + triggers AFTER INSERT / AFTER DELETE para sync FTS5

-- ═══ RUNS ═══
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_root  TEXT    NOT NULL,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  status        TEXT    NOT NULL DEFAULT 'running',
  total_files   INTEGER NOT NULL DEFAULT 0,
  indexed_files INTEGER NOT NULL DEFAULT 0,
  skipped_files INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  provider      TEXT    NOT NULL DEFAULT '',
  model         TEXT    NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  embedding_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0
);

-- ═══ SNAPSHOTS ═══
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT 'note',
  content       TEXT    NOT NULL,
  tags          TEXT    NOT NULL DEFAULT '[]',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  created_by    TEXT    NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_snap_project ON snapshots(project_id);

-- ═══ COSTS ═══
CREATE TABLE IF NOT EXISTS costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider      TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  operation     TEXT    NOT NULL,
  file_path     TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costs_project ON costs(project_id);
CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);

-- ═══ WEBHOOKS ═══
CREATE TABLE IF NOT EXISTS webhooks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  url             TEXT    NOT NULL,
  events          TEXT    NOT NULL DEFAULT '[]',
  secret          TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL,
  last_triggered  TEXT,
  last_status     INTEGER
);

-- ═══ FILE SNAPSHOTS (para diff) ═══
CREATE TABLE IF NOT EXISTS file_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL,
  path         TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  summary      TEXT    NOT NULL DEFAULT '',
  concepts     TEXT    NOT NULL DEFAULT '[]',
  symbols_json TEXT    NOT NULL DEFAULT '[]',
  UNIQUE(run_id, path)
);
CREATE INDEX IF NOT EXISTS idx_fsnap_run ON file_snapshots(run_id);

-- ═══ VECTOR IDs (tracking de vetores no Cloudflare Vectorize) ═══
CREATE TABLE IF NOT EXISTS vector_ids (
  id          TEXT    PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,
  ref_id      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vid_project ON vector_ids(project_id);

-- ═══ MODELS CACHE ═══
CREATE TABLE IF NOT EXISTS models_cache (
  provider      TEXT    PRIMARY KEY,
  models_json   TEXT    NOT NULL,
  fetched_at    INTEGER NOT NULL
);
```

---

## 16. Dashboard (telas atualizadas)

**1. Home / Projetos** — cards, busca global, status de watcher (watching/stopped)

**2. Detalhe do Projeto** — tabs:
- **Search** — busca híbrida (keyword + semântica), toggle FTS/Vector/Hybrid
- **Files** — árvore com summaries
- **Concepts** — tag cloud
- **Symbols** — tabela pesquisável
- **Snapshots** — criar/editar/listar (editor markdown inline)
- **Diff** — comparar 2 runs, visualização visual de added/removed/modified
- **Costs** — gráfico de custo por run, por provider, acumulado
- **Runs** — histórico com custo por run
- **Settings** — provider/model, exclusões, webhooks, watcher on/off

**3. Settings Global** — providers, modelos (live discovery), embeddings config, custos totais

---

## 17. MCP Server — Tools Completas

| Tool | Input | Descrição |
|---|---|---|
| `list_projects` | — | Lista projetos com stats |
| `index_project` | `project_name?`, `project_root?`, `provider?`, `model?`, `force?` | Indexa (auto-registra) |
| `search` | `project_name`, `query`, `mode?` (fts\|vector\|hybrid), `type?`, `limit?` | Busca híbrida |
| `search_global` | `query`, `limit?` | Busca em todos os projetos |
| `get_file_structure` | `project_name`, `path` | Outline de arquivo |
| `get_symbol_details` | `id` | Detalhes de símbolo |
| `get_class_members` | `id` | Membros de classe |
| `search_by_concept` | `project_name`, `concept` | Arquivos por conceito |
| `get_project_stats` | `project_name` | Stats + custos |
| `get_project_overview` | `project_name` | Summary completo + conceitos + linguagens |
| `get_project_context` | `project_name` | Retorna snapshots formatados como contexto |
| `add_snapshot` | `project_name`, `title`, `category`, `content`, `tags?` | Cria snapshot |
| `list_snapshots` | `project_name`, `category?` | Lista snapshots |
| `update_snapshot` | `id`, `content?`, `title?` | Atualiza snapshot |
| `delete_snapshot` | `id` | Remove snapshot |
| `get_diff` | `project_name`, `run_before?`, `run_after?` | Diff entre runs |
| `get_costs` | `project_name?`, `since?` | Custos do projeto ou global |
| `estimate_cost` | `project_name`, `provider?`, `model?` | Estimativa antes de indexar |
| `export_docs` | `project_name`, `sections?`, `output_path?` | Gera documentação markdown |
| `list_models` | `provider?`, `live?` | Modelos disponíveis |

---

## 18. CLI Completo

```bash
# ═══ PROJETOS ═══
mcp-code-indexer projects
mcp-code-indexer projects add <name> <path>
mcp-code-indexer projects remove <name>
mcp-code-indexer projects info <name>

# ═══ INDEXAÇÃO ═══
mcp-code-indexer index <name-or-path> [--provider=zai] [--model=glm-5] [--force] [--concurrency=5]

# ═══ BUSCA ═══
mcp-code-indexer search <project> <query>              # hybrid search (default)
mcp-code-indexer search <project> <query> --mode=fts    # keyword only
mcp-code-indexer search <project> <query> --mode=vector # semantic only
mcp-code-indexer search --global <query>

# ═══ CONSULTAS ═══
mcp-code-indexer file <project> <path>
mcp-code-indexer symbol <id>
mcp-code-indexer class <id>
mcp-code-indexer concept <project> <concept>
mcp-code-indexer stats <project>
mcp-code-indexer runs <project>
mcp-code-indexer list <project> [language]

# ═══ SNAPSHOTS ═══
mcp-code-indexer snapshots <project>
mcp-code-indexer snapshots add <project> --title="..." --category=decision --content="..."
mcp-code-indexer snapshots edit <id> --content="..."
mcp-code-indexer snapshots remove <id>
mcp-code-indexer context <project>                      # formatted context output

# ═══ DIFF ═══
mcp-code-indexer diff <project>
mcp-code-indexer diff <project> --run-before=5 --run-after=8

# ═══ CUSTOS ═══
mcp-code-indexer costs
mcp-code-indexer costs <project>
mcp-code-indexer costs --since=2025-01-01
mcp-code-indexer costs estimate <project> --provider=zai --model=glm-5

# ═══ EXPORT ═══
mcp-code-indexer export <project>
mcp-code-indexer export <project> --sections=overview,architecture,api
mcp-code-indexer export <project> --output=./docs/CODEBASE.md --include-snapshots

# ═══ WATCHER ═══
mcp-code-indexer watch <project>
mcp-code-indexer watch --all
mcp-code-indexer watch --all --daemon

# ═══ WEBHOOKS ═══
mcp-code-indexer webhooks list
mcp-code-indexer webhooks add --project=<name> --url=https://... --events=index.done
mcp-code-indexer webhooks remove <id>
mcp-code-indexer webhooks test <id>

# ═══ MODELOS ═══
mcp-code-indexer models
mcp-code-indexer models --live --provider=zai

# ═══ CONFIG ═══
mcp-code-indexer init [dir]

# ═══ SERVER ═══
mcp-code-indexer serve [--port=3333]
```

---

## 19. Config File (.mcp-indexer.json)

```json
{
  "provider": "zai",
  "model": "glm-4.7-flash",
  "concurrency": 5,
  "maxFileSizeKB": 200,
  "ignore": ["tests/**", "docs/**", "*.spec.ts"],
  "dbPath": "~/.mcp-code-indexer/index.db",
  "embeddings": {
    "enabled": true,
    "workerUrl": "https://mcp-indexer-worker.<account>.workers.dev",
    "workerToken": "shared-secret-here",
    "model": "@cf/baai/bge-m3",
    "dimensions": 1024
  },
  "watcher": {
    "enabled": false,
    "debounceMs": 2000,
    "autoIndex": true
  },
  "webhooks": [
    {
      "url": "https://n8n.zapcode.ai/webhook/index-complete",
      "events": ["index.done", "index.failed"],
      "secret": "whsec_..."
    }
  ],
  "costTracking": true,
  "dashboard": {
    "port": 3333,
    "host": "0.0.0.0"
  }
}
```

---

## 20. Variáveis de Ambiente

| Variável | Descrição |
|---|---|
| `ANTHROPIC_API_KEY` | Provider Anthropic |
| `OPENAI_API_KEY` | Provider OpenAI + Embeddings |
| `DEEPSEEK_API_KEY` | Provider DeepSeek |
| `GEMINI_API_KEY` | Provider Google Gemini |
| `ZAI_API_KEY` | Provider Z.AI / Zhipu (GLM) |
| `MCP_INDEX_DB` | Path do SQLite (default: `~/.mcp-code-indexer/index.db`) |
| `MCP_INDEX_WORKER_URL` | URL do Worker proxy Cloudflare para embeddings + Vectorize |
| `MCP_INDEX_WORKER_TOKEN` | Token compartilhado de autenticação com o Worker |
| `MCP_INDEX_PROVIDER` | Provider padrão |
| `MCP_INDEX_MODEL` | Modelo padrão |
| `MCP_INDEX_PORT` | Porta do dashboard/API (default: 3333) |
| `MCP_INDEX_EMBEDDINGS` | `true`/`false` — habilitar embeddings (default: `true`) |

---

## 21. Dependências (package.json)

```json
{
  "name": "mcp-code-indexer",
  "version": "3.1.0",
  "description": "LLM-powered multi-project codebase indexer with hybrid search, dashboard, and MCP server",
  "type": "module",
  "bin": {
    "mcp-code-indexer": "./dist/cli.js",
    "mcp-code-indexer-server": "./dist/mcp/server.js"
  },
  "scripts": {
    "build": "tsc && vite build src/dashboard",
    "dev:server": "tsx watch src/mcp/server.ts",
    "dev:api": "tsx watch src/api/server.ts",
    "dev:dashboard": "vite dev src/dashboard",
    "dev": "concurrently \"npm:dev:api\" \"npm:dev:dashboard\""
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.36.3",
    "@google/generative-ai": "^0.x",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^9.4.3",
    "chokidar": "^4.x",
    "glob": "^11.0.0",
    "hono": "^4.x",
    "ignore": "^5.3.1",
    "openai": "^4.x",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "@types/node": "^20.0.0",
    "@types/react": "^18.x",
    "@types/react-dom": "^18.x",
    "@vitejs/plugin-react": "^4.x",
    "autoprefixer": "^10.x",
    "concurrently": "^8.x",
    "postcss": "^8.x",
    "react": "^18.x",
    "react-dom": "^18.x",
    "tailwindcss": "^3.x",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0",
    "vite": "^5.x"
  }
}
```

---

## 22. Pipeline de Indexação Completo (v3.1)

```
1. Resolve projeto (por nome, path ou auto-detect)
   → Se não existe, auto-registra

2. FileScanner varre diretório (glob + .gitignore)
   → Calcula SHA256 de cada arquivo
   → Compara com hash no DB
   → Classifica: toIndex | unchanged | toRemove

3. Remove arquivos deletados do DB + LanceDB

4. Estima custo (CostTracker.estimateCost) — log no console

5. Inicia run (db.startRun)

6. Para cada arquivo em toIndex (concurrency limitada):
   a. Lê conteúdo
   b. Chama provider.analyzeFile(path, content) → AnalysisResult
   c. CostTracker.record(analysis tokens)
   d. db.upsertFile(projectId, analysis)
   e. Salva file_snapshot para diff futuro
   f. Reporta progresso via callback

7. Gera textos de embedding para arquivos/símbolos alterados
8. Chama EmbeddingService.embed(texts) em batch (até 2048/chamada)
9. CostTracker.record(embedding tokens)
10. VectorStore.upsertProjectVectors(records)

11. Atualiza contadores no projeto (file_count, symbol_count, last_indexed)
12. Finaliza run (db.finishRun com totais de tokens e custo)

13. Dispara webhooks: "index.done" ou "index.failed"

14. Se primeira indexação, gera auto-snapshot "Project Overview"
15. Se conceitos novos surgiram, gera auto-snapshot "New Concepts"

16. Retorna IndexResult
```

---

## 23. Notas de Implementação

### 23.1 Paths relativos no DB
`files.path` é relativo ao `project.root_path`. Permite mover o projeto sem re-indexar.

### 23.2 FTS5 scoped por projeto
```sql
SELECT s.* FROM symbols_fts fts
JOIN symbols s ON s.id = fts.rowid
WHERE fts.symbols_fts MATCH ? AND s.project_id = ?
ORDER BY rank LIMIT ?
```

### 23.3 Vectorize filter por projeto
```typescript
// Via Worker proxy, filter is passed as metadata filter
{ filter: { project_name: "zapcode-api" } }
```

### 23.4 Embedding batch sizing
Batch de até 100 textos por chamada (limite Workers AI). O EmbeddingService divide automaticamente em chunks.

### 23.5 Concurrency (semáforo)
```typescript
async function withConcurrency<T>(items: T[], fn: (item: T) => Promise<void>, limit: number): Promise<void>
```

### 23.6 SHA256
```typescript
import { createHash } from "crypto";
createHash("sha256").update(content).digest("hex");
```

### 23.7 Shebang em entry points
```typescript
#!/usr/bin/env node
```

### 23.8 Graceful shutdown no watcher
```typescript
process.on("SIGINT", () => { watcherService.stopAll(); process.exit(0); });
process.on("SIGTERM", () => { watcherService.stopAll(); process.exit(0); });
```
