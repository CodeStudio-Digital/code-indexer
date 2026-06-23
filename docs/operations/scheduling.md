# Scheduling — 270s cache-aware heartbeat & cron picks

> **Audience:** anyone setting up recurring or polling work in D:\MCP — schedules in the company SchedulerService (Item A), `/loop` workers in Claude Code, ScheduleWakeup-based polling.

## TL;DR

| You want to… | Use | Delay/cron |
|---|---|---|
| Poll a fast-changing external state from inside a chat | `ScheduleWakeup` | **≤270s** (stays in prompt cache) |
| Wait for slow async work the harness can't notify | `ScheduleWakeup` | **1200-3600s** (one cache miss buys a long wait) |
| Run periodic maintenance (audit, doc drift, testgaps) | company `SchedulerService` cron | depends on cost — see table below |
| One-off "ping me in N min" | Claude Code skill `schedule` (cron at-time) | exact time |

**Never pick 300s.** It's worst-of-both: you pay the cache miss but barely buy more wait. Drop to 270s (cache warm) or commit to ≥1200s (cache miss amortized).

## The Anthropic prompt-cache math

The Anthropic prompt cache holds the conversation context for **5 minutes** since last read. If you wake up within 300s, the next turn reads context from cache (fast, cheap). Past 300s, the next turn reads it fresh (slow, expensive).

The cliff is sharp. Each second over 300s costs the SAME as 3000s — once you've paid the miss, you've paid it.

So in-cache windows make sense for **actively polling external state** the harness can't push to you (CI runs, deploys, queues). Cache-miss windows make sense when you're **genuinely idle** and a 20-minute check-back is fine.

## Recommended delays for `ScheduleWakeup`

```
0s ─────── 60s ─────── 270s ─────── 300s ─────── 600s ─────── 1200s ─────── 3600s
            └─ rapid poll ─┘    ⚠      └── dead zone ──┘     └── idle tick ──┘
                                cliff   (don't pick here)      (preferred)
```

| Range | When | Why |
|---|---|---|
| **60-90s** | Watching a fast CI job (~2-3 min) | Stays in cache; ~2 wakes covers it |
| **120-180s** | Mid-paced async work (5-10 min total) | 2-3 wakes, all in cache |
| **270s** | Last-chance heartbeat before cache expires | The maximum "stay warm" duration |
| **300-1199s** | **Avoid** — paid the cache miss, didn't amortize it | — |
| **1200-1800s** | Idle tick (default for self-paced loops) | One miss, long wait |
| **3600s** | Long-running async work (deploys, big jobs) | Same single miss, even longer wait |

The runtime clamps to `[60, 3600]`.

## Cron picks for D:\MCP background workers

When you adopt the company `SchedulerService` (Item A of the ruflo adoption plan), pick cron expressions based on **cost × value frequency**:

| Worker / schedule | Suggested cron | Reasoning |
|---|---|---|
| `index_refresh` | `*/15 * * * *` | Incremental re-index of changed files; cheap |
| `audit` | `*/30 * * * *` | Security/policy scan; medium cost |
| `testgaps` | `0 */2 * * *` | Coverage gap detection → test generation; expensive (subagent run) |
| `document` | `0 */4 * * *` | Docs drift via docs-agent; expensive |
| `consolidate` | `0 0 * * *` | LSH consolidation + snapshot dedup; do overnight |
| `optimize` | `0 0 * * *` | Cost-tracker scan; nightly is enough |
| `preload` | event-driven (not cron) | Fires on project-open event |
| `deepdive` | manual only | On-demand; users dispatch via UI |

**Default for "I don't know" is `0 */4 * * *`.** Two per day is rarely too much, never too little.

## Anti-patterns

- **Loop with sub-60s delays.** The clamp makes them 60s anyway, and that's already aggressive — most external state doesn't change every minute.
- **Cron `* * * * *` (every minute).** Burns budget on every project for marginal benefit. Use event triggers for sub-15-minute granularity.
- **Sleeping between commands** that can run sequentially. Don't `setTimeout` for "wait for thing to settle" — just run the next command.
- **Polling background tasks the harness tracks.** If you ran a tool with `run_in_background: true`, you get notified when it finishes. Don't sleep + check.
- **Picking 5 minutes "to be safe."** That's the cache-cliff. Drop to 4:30 (270s) or commit to 20 min.

## Implementation references

- ScheduleWakeup primitive: Claude Code harness (`tools/ScheduleWakeup`).
- Cron parser (when SchedulerService lands): parse via `cron-parser` (npm), tick via `setInterval` at 60s granularity.
- 270s constant: `RUFLO_LOOP_HEARTBEAT_SECONDS = 270` — name keeps the rationale visible.
- ADR-0001 from `plugins/ruflo-autopilot` in ruflo's repo — original source of the cache-aware contract.

## See also

- `docs/architecture/namespace-convention.md` — naming for new schedules + event channels
- `docs/research/ruflo/specs/001-background-workers.md` — the original spec (note: superseded by the SchedulerService-extending-company approach in the revised plan)
- `packages/company/src/services/SchedulerService.ts` — actual implementation (once Item A lands)
