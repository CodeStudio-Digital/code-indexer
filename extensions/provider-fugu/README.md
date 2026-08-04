# provider-fugu

Sakana AI **Fugu** as a bundled, declarative provider plugin.

Fugu is a multi-agent frontier model served over the OpenAI API
(`https://api.sakana.ai/v1` — chat/completions, responses, and `/models`). This
plugin contributes it through the `providers` contribution point by re-exporting
the canonical `fuguSpec` from `@mcp/provider-engine`.

## Models

| Model | Notes |
| --- | --- |
| `fugu` | Balanced everyday model; routes to the best-fit agent. |
| `fugu-ultra` / `fugu-ultra-v1.1` | Larger expert ensemble for hard problems; supports distinct `max` effort. |
| `fugu-ultra-v1.0` / `fugu-ultra-20260615` | Previous pinned Ultra version. |
| `fugu-cyber` | Access-gated cybersecurity model. |

## Reasoning effort

Fugu reasons by default. The plugin uses Sakana's recommended stateless Responses
API and sends `reasoning: { effort, summary: "auto" }`. The summary request is
enabled for every current Fugu model so provider-returned reasoning is streamed
through the product's thinking UI. `fugu-ultra-v1.1` supports distinct `high`,
`xhigh`, and `max` levels; the other current families expose their documented
subset. Leaving effort unset keeps the selected model's server default while
still requesting a readable reasoning summary.

## Configuration

Set `FUGU_API_KEY` (or paste the key when adding the provider in Admin →
Providers), then **Refresh models**. The base URL defaults to
`https://api.sakana.ai/v1`.
