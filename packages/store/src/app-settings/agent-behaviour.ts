import type { SettingDef } from './types.js';

/** Agent — high-level behaviour: profile, turns, sub-agents, loop version. */
export const AGENT_BEHAVIOUR_SETTINGS: readonly SettingDef[] = [
  {
    key: 'CODER_PROFILE',
    label: 'Default coder profile',
    description: 'Which tool tiers start active. `auto` picks based on the user\'s first message.',
    type: 'string',
    category: 'agent',
    options: ['auto', 'bootstrap', 'navigate', 'full'],
  },
  {
    key: 'CODER_PROFILE_AUTO',
    label: 'Auto-profile from first message',
    description: 'Inspect the first user message to pick bootstrap/navigate/full when profile is unset.',
    type: 'bool',
    category: 'agent',
    default: '0',
  },
  {
    key: 'CODER_STICKY_PROFILE',
    label: 'Sticky tool profile per session',
    description:
      'Persist the resolved tool profile/pins on the session and reuse them on resume (widen-only). ' +
      'Off = legacy per-run inference, which can flip the visible toolset between rounds and bust the provider prompt cache.',
    type: 'bool',
    category: 'agent',
    default: '1',
    advanced: true,
  },
  {
    key: 'CODER_SELF_REVIEW',
    label: 'Auto-review reminder',
    description:
      'Remind the agent to call self_review (the configured review pipeline over its own edits) ' +
      'when the session has pending changes. The self_review tool stays available either way.',
    type: 'bool',
    category: 'agent',
    default: '1',
  },
  {
    key: 'CODER_IMPLEMENT_MAX_TURNS',
    label: 'Build mode max turns',
    description: 'Optional exact turn cap for build/implement subagents. 0 = unlimited.',
    type: 'int',
    category: 'agent',
    default: '0',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_REVIEW_MAX_TURNS',
    label: 'Reviewer subagent max turns',
    description: 'Optional exact turn cap for the `request_review` reviewer. 0 = unlimited.',
    type: 'int',
    category: 'agent',
    default: '0',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_GOAL_VERIFY_MAX_TURNS',
    label: 'Completion verifier max turns',
    description:
      'Turn cap for the independent completion verifier. Defaults to 12; values below 1 fall back to 12, and the hard maximum is 50.',
    type: 'int',
    category: 'agent',
    default: '12',
    min: 1,
    max: 50,
    advanced: true,
  },
  {
    key: 'CODER_FINISH_EVIDENCE_ROLLOUT_PERCENT',
    label: 'Completion-evidence gate rollout %',
    description:
      'Percent of sessions (deterministic per session id) that get the one-shot completion-evidence nudge: ' +
      'before saying work is done, if edits were made without a fresh test/typecheck/lint/build, the agent is ' +
      'reminded once (reversible). 0 disables; 100 enables for everyone.',
    type: 'int',
    category: 'agent',
    default: '100',
    min: 0,
    max: 100,
    advanced: true,
  },
  {
    key: 'CODER_BUG_WORKFLOW',
    label: 'Bug reproduction-first workflow',
    description:
      'For sessions the preflight classifies as a bugfix, inject a short reproduce-before-fix workflow ' +
      '(reproduction that fails → root cause → minimal fix → confirm before-fails/after-passes). ' +
      'Purely advisory text; set 0 to suppress it.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_PARALLEL_AGENT_MAX',
    label: 'Max parallel sub-agents',
    description: 'How many `spawn_agents` workers can run concurrently.',
    type: 'int',
    category: 'agent',
    default: '4',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_DISABLE_SUBAGENTS',
    label: 'Disable sub-agents entirely',
    description: 'Forces `spawn_subagent` / `spawn_agents` to refuse with an explanatory error.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_AGENTLESS_MODE',
    label: 'Agentless mode',
    description: 'Pre-Agent-Loop-v2 behaviour. Mostly for regression testing.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_AGENT_LOOP_V2',
    label: 'Agent Loop v2',
    description: 'Newer turn-management loop with dedup + protect-window heuristics. ON by default in newer builds.',
    type: 'bool',
    category: 'agent',
    default: '1',
    advanced: true,
  },
  {
    key: 'CODER_NEW_COMPACTION',
    label: 'New compaction strategy',
    description: 'Use the rolling-window compactor (vs the legacy summarizer).',
    type: 'bool',
    category: 'agent',
    default: '1',
    advanced: true,
  },
  {
    key: 'MCP_DURABLE_COMPACTION',
    label: 'Durable compaction',
    description:
      'Persist automatic compaction (summary + recent tail) to the session so the next run starts compacted, reducing token cost across runs. Old messages stay reopenable via "view earlier history".',
    type: 'bool',
    category: 'agent',
    default: '1',
  },
  {
    key: 'CODER_CONVERSATION_CHAPTERS',
    label: 'Conversation chapters',
    description:
      'Persist every durable compaction as an immutable, searchable chapter. ' +
      'Disable to fall back to the legacy single rolling summary.',
    type: 'bool',
    category: 'agent',
    default: '1',
  },
  {
    key: 'CODER_COMPACT_PROTECT_RATIO',
    label: 'Compaction keep ratio',
    description:
      'Fraction of the context window kept verbatim as the recent tail when compacting (the rest is summarized). Lower = cheaper but less recent detail. Default 0.30.',
    type: 'float',
    category: 'agent',
    default: '0.3',
    min: 0.05,
    max: 0.6,
    advanced: true,
  },
  {
    key: 'CODER_COMPACT_MIN_TAIL_TURNS',
    label: 'Compaction min tail turns',
    description:
      "Minimum number of recent renderable turns (user + assistant) always kept verbatim when compacting, regardless of token size — a floor so a token-dense tail can't collapse to nothing. Capped by the keep ratio so it never overflows the window. Default 8.",
    type: 'int',
    category: 'agent',
    default: '8',
    min: 0,
    max: 100,
    advanced: true,
  },
  {
    key: 'CODER_COMPACT_MIN_TAIL_FRACTION',
    label: 'Compaction min tail fraction',
    description:
      'Floor on the recent tail expressed as a fraction of the visible renderable turns (0–0.6). The effective floor is the larger of this fraction and the min-tail-turns count. 0 disables the fractional floor. Default 0.10.',
    type: 'float',
    category: 'agent',
    default: '0.1',
    min: 0,
    max: 0.6,
    advanced: true,
  },
  {
    key: 'CODER_COMPACT_TRIGGER_RATIO',
    label: 'Compaction trigger ratio',
    description:
      'Fraction of the effective context window at which auto-compaction fires (one knob drives the size gate, the body gate at −0.05 and the token backstop). Default 0.90 — lower it to summarize earlier and keep more headroom.',
    type: 'float',
    category: 'agent',
    default: '0.9',
    min: 0.5,
    max: 0.95,
    advanced: true,
  },
  {
    key: 'MCP_MEMORY_SWEEPER',
    label: 'Idle memory sweeper',
    description:
      'Distills durable project memory from sessions that went idle (≥10 min) with un-distilled messages. Complements the compaction-time harvest so short sessions also feed project memory. Default on.',
    type: 'bool',
    category: 'agent',
    default: '1',
  },
  {
    key: 'MCP_MEMORY_IDLE_AFTER_MS',
    label: 'Memory sweeper idle threshold (ms)',
    description:
      'How long a session must sit idle before the sweeper distills its pending span. Default 600000 (10 min).',
    type: 'int',
    category: 'agent',
    default: '600000',
    min: 60000,
    advanced: true,
  },
  {
    key: 'CODER_PREFLIGHT',
    label: 'Task preflight (first-prompt analysis)',
    description:
      'A cheap model analyzes the first prompt of a fresh session and seeds it: minimal tool ' +
      'profile, pinned tools (incl. relevant external MCP tools), suggested skills, and which ' +
      'project memories to read. Runs zero-config — uses the code-agent/preflight binding ' +
      '(Admin → Pipelines) if set, otherwise the general default AI model. This is the kill-switch.',
    type: 'bool',
    category: 'agent',
    default: '1',
  },
  {
    key: 'CODER_PREFLIGHT_TIMEOUT_MS',
    label: 'Task preflight timeout (ms)',
    description:
      'Hard ceiling for the preflight one-shot call. The first message of a fresh session BLOCKS on ' +
      'this analysis (the chat shows an "Analyzing the task…" indicator while it runs); on timeout the ' +
      'call is cancelled and the session starts unseeded. Buffered providers (z.ai, ChatGPT) need ' +
      '~10-12s for a complete response, so the default is generous.',
    type: 'int',
    category: 'agent',
    default: '20000',
    min: 500,
    advanced: true,
  },
  {
    key: 'CODER_PREFLIGHT_MAX_TOOLS',
    label: 'Task preflight max pinned tools',
    description: 'How many non-overlapping tools the analyzer may prioritize on turn 1.',
    type: 'int',
    category: 'agent',
    default: '4',
    min: 1,
    advanced: true,
  },
  {
    key: 'CODER_PREFLIGHT_EXT_CATALOG_MAX',
    label: 'Task preflight external MCP catalog cap',
    description:
      'How many cached external MCP-server tools are shown to the preflight analyzer (input cap, ' +
      'bounds prompt cost). Native tools are always included; this only limits external tools. ' +
      'Set 0 to hide external MCP tools from preflight entirely.',
    type: 'int',
    category: 'agent',
    default: '40',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_PREFLIGHT_SKILLS_MAX',
    label: 'Task preflight skills catalog cap',
    description:
      'How many active skills are shown to the preflight analyzer (input cap, bounds prompt cost). ' +
      'The analyzer suggests a small subset of these as task-relevant. Set 0 to disable skill suggestions.',
    type: 'int',
    category: 'agent',
    default: '30',
    min: 0,
    advanced: true,
  },
  {
    key: 'CODER_PREFLIGHT_VISIBLE_CAP',
    label: 'Task preflight visible-tool cap',
    description:
      'Seeded sessions cap their visible tool list at min(model cap, this). NEVER_TRIM tools and ' +
      'preflight pins always survive; hidden tools stay callable via find_tools.',
    type: 'int',
    category: 'agent',
    default: '28',
    min: 16,
    advanced: true,
  },
  {
    key: 'CODER_PROMPTS_WATCH',
    label: 'Hot-reload system prompts',
    description:
      'Watch packages/code-agent/src/prompts/*.txt and rebuild the system prompt on save. Useful when iterating on prompt copy.',
    type: 'bool',
    category: 'agent',
    default: '0',
    advanced: true,
  },
  {
    key: 'CODER_FALLBACK_CHAIN',
    label: 'Provider fallback chain',
    description: 'Comma-separated provider ids to try in order when the primary 5xx/429s.',
    type: 'string',
    category: 'agent',
    advanced: true,
  },
];
