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
| `fugu-ultra` | Larger expert ensemble for hard problems (higher cost). |
| `fugu-ultra-20260615` | Pinned alias of a specific `fugu-ultra` version. |

## Reasoning effort

Fugu reasons by default. The OpenAI-compatible Chat Completions request accepts a
**`reasoning_effort`** string with values `high`, `xhigh`, or `max` (`xhigh` and
`max` are aliases of the same effort; the server default is `xhigh`). The session
reasoning-effort selector forwards the chosen level; leaving it unset lets Fugu
apply its `xhigh` default.

## Configuration

Set `FUGU_API_KEY` (or paste the key when adding the provider in Admin →
Providers), then **Refresh models**. The base URL defaults to
`https://api.sakana.ai/v1`.
