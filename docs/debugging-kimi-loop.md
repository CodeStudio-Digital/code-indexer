# Debugging Kimi-Code provider loops

Quando o agente fica preso em loop de tools usando o provider KIMI, ative o logging diagnóstico opt-in deste documento. Zero overhead quando desligado.

## Ativando

Duas variáveis de ambiente independentes (ative as duas):

```bash
KIMI_CODE_DEBUG=1        # logs do provider: requests, tool_call chunks, flushes, finish
CODER_DOOM_LOOP_DEBUG=1  # logs do runner: doom-loop guards (strict/fuzzy/dup-call/result-dup)
```

Aceito também `CODER_PROVIDER_DEBUG=1` como alias do primeiro.

Ambas escrevem em **stderr**, prefixadas para grep:

| Prefixo | Origem |
|---|---|
| `[kimi-debug]` | `packages/code-agent/src/providers/kimi-code-debug.ts` |
| `[doom-loop-debug]` | `packages/code-agent/src/core/runner.ts:527` |

## Formato dos eventos `[kimi-debug]`

Cada linha é JSON. Eventos emitidos:

### `request` — antes de chamar a API
```json
{"event":"request","model":"kimi-k2.6","messageRoles":["system","user","assistant","tool","user"],
 "messageCount":5,"toolCount":18,"hasThinking":true,"promptCacheKey":"coder-session-42",
 "assistantContentTypes":["omitted"]}
```
- **`assistantContentTypes`** confirma/refuta **H2** (Kimi rejeita `content: ""` ou whitespace-only com tool_calls). Valores possíveis: `omitted` (correto), `empty`, `whitespace` (suspeito), `text`, `array:N`, `other`.

### `tool_chunk` — cada chunk de tool_call recebido em streaming
```json
{"event":"tool_chunk","idx":0,"id":"call_abc","name":"read_file",
 "argsDelta":"{\"path\":\"x.t","argsAccLen":14,"emittedStart":false}
```
- **`argsAccLen` crescendo monotonicamente** ✓ normal.
- **`argsAccLen` saltando para valor menor + delta começando com `{`** = re-emissão de chunk → confirma **H1** (causa parse fail no flush).
- **`emittedStart: false` + tool_call_args inferido depois** = confirma **H3** (ordem invertida).

### `tool_flush` — quando o turno termina e parseia argsAcc
```json
{"event":"tool_flush","id":"call_abc","name":"read_file","argsAccLen":47,
 "parseOk":true,"argsPreview":"{\"path\":\"x.ts\",\"around_line\":100}"}
```
- **`parseOk: false`** confirma **H1** — o runner vai receber `input: { _raw: "..." }` e a tool vai falhar.
- **`argsAccLen` muito acima do tamanho real do JSON** = duplicação de chunks.

### `finish` — fim do stream
```json
{"event":"finish","stopReason":"tool_calls","finishedNormally":true}
```
- **`finishedNormally: false`** = stream encerrou sem `finish_reason` → flush forçado, pode entregar args incompletos.

## Roteiro de reprodução

1. Ative as duas env vars no shell em que roda o app (Electron ou dev server).
2. Abra a IDE/CLI, selecione o provider Kimi e modelo (`kimi-k2.6` default).
3. Rode 2-3 prompts que você lembra de já ter visto loopar. Preferir tarefas que envolvam **read_file + edit_file repetidos** ou que toquem muitos arquivos.
4. Redirecione stderr pra arquivo:
   ```bash
   pnpm dev:dashboard 2> .reference/kimi-loop-repro-$(date +%s).jsonl
   ```
   (`.reference/` é ignorado pelo git, então tá safe.)
5. Aguarde o loop disparar (ou o `doom-loop-strict` abortar). Pare a sessão.
6. Analise o jsonl:

```bash
# Quantos tool_flush com parse fail (H1)?
grep -c '"parseOk":false' .reference/kimi-loop-repro-*.jsonl

# Algum request com content suspeito (H2)?
grep '"event":"request"' .reference/kimi-loop-repro-*.jsonl \
  | grep -E '"(empty|whitespace)"'

# Qual guard disparou primeiro (H4)?
grep '\[doom-loop-debug\]' .reference/kimi-loop-repro-*.jsonl | head -20

# Stream cortado antes de finish_reason?
grep '"finishedNormally":false' .reference/kimi-loop-repro-*.jsonl
```

## Interpretando: qual hipótese?

| Sintoma | Hipótese confirmada | Próxima ação |
|---|---|---|
| `parseOk: false` ≥ 1× | H1 | Parsing tolerante a re-chunks (deduplicar) |
| `assistantContentTypes` contém `empty`/`whitespace` | H2 | Espelhar `_is_effectively_empty_content_parts` do kosong |
| `tool_chunk` com `argsDelta` antes de `emittedStart: true` | H3 | Reordenar emissão de start vs args |
| Doom-loop dispara mas input chega íntegro | H5 | Ajustar system prompt do Kimi com anti-loop explícito |
| Nenhuma das acima — só `[doom-loop-debug]` aborta | Bug no nível do modelo | Reportar pra Moonshot ou tunar guard thresholds |

## Onde editar

- Logger: [packages/code-agent/src/providers/kimi-code-debug.ts](packages/code-agent/src/providers/kimi-code-debug.ts)
- Provider instrumentado: [packages/code-agent/src/providers/kimi-code.ts](packages/code-agent/src/providers/kimi-code.ts)
- Runner guards: [packages/code-agent/src/core/runner.ts:517-527, 4407-4540](packages/code-agent/src/core/runner.ts:517)

## Quando fechar a investigação

Quando 1+ hipótese tiver evidência observável citável (trecho do jsonl) e for hora de fazer o fix, abrir plano separado da **Fase E** do `https-github-com-moonshotai-kimi-cli-purrfect-sparkle.md`. Comparar com a auditoria em [docs/audits/kimi-cli-comparison.md](docs/audits/kimi-cli-comparison.md) — item HIGH H1 já antecipa o fix de H2.
