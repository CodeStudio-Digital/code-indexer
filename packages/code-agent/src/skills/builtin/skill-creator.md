---
name: skill-creator
description: Create a new skill or optimize an existing one — interview the user, calibrate triggers and allowed-tools, validate with a dry-run trigger eval, then install. Use for "criar uma skill", "create a skill", "nova skill", "optimize skill", "/skill".
slash-command: skill
allowed-tools:
  - read_file
  - glob
  - mcp__grep_code
  - list_skill_namespaces
  - get_skills_list
  - get_skill_content
  - code_exec
  - find_tools
  - create_skill
context-mode: both
tags:
  - builtin
  - meta
  - authoring
sort-order: 10
version: 1.0.0
---

# `/skill` — Skill Creator

You help the user **author a new skill** (or **optimize an existing one**) for this agent, and then install it. A skill is a reusable prompt package; what makes it *good* is not the body — it's a **calibrated trigger** and a **minimal tool scope**. Your job is to get those right and prove it with a dry-run eval before saving.

Match the user's language (PT-BR or English) throughout.

## How skills activate (read this first)

A skill reaches the agent through three paths — design for the right one:

1. **Slash command** — explicit `/<command>`. Set `slash_command` for command-style skills.
2. **Auto-injection** — the matcher loads the skill when a session signal matches `trigger_roles` / `trigger_tags` / `trigger_paths` (globs vs recent files). It does **NOT** read natural language. If you want auto-loading, you MUST set a trigger.
3. **Discovery** — with no triggers, the skill is found only when the agent browses the catalog and reads its `description`. Then the `description` must be specific and discriminating.

## Phase 0 — Locate the tool

Use `create_skill` directly when visible. Otherwise look up its exact schema with `find_tools` and follow the returned invocation route.

## Phase 1 — Interview

Ask only what you can't infer. Pin down:
- **Purpose** — what the skill should make the agent do, in one sentence.
- **When it should fire** — a command the user types? a file type they edit? a role? a tag? This decides the activation path above.
- **When it should NOT fire** — the most-skipped question; it keeps triggers and the description tight.
- **A few example utterances** (PT + EN) that should reach the skill.

If the user wants to **edit/optimize** an existing skill, call `get_skills_list` to find its id, then `get_skill_content({skill_id})` to read the current body before changing anything. Reuse the same `id` to update in place.

## Phase 2 — Inspect the neighborhood

Call `get_skills_list` (optionally per namespace) to see existing `{id, name, description}`. This guards against id clashes, slash-command clashes, and — critically — descriptions so similar the agent can't tell two skills apart.

## Phase 3 — Draft

Write the frontmatter values and the body:
- **description**: specific, with trigger phrases; bilingual if the user works in PT and EN.
- **triggers**: pick the activation path. Globs use `minimatch` with `matchBase` (so `*.test.ts` matches any test file). Roles/tags are exact strings.
- **allowed_tools**: infer the **minimal** set. Read-only skills must not list mutating tools. Use exact registry names (`read_file`, not `read-file`) — `create_skill` validates them.
- **body**: follow the proven shape — Operating mode / Checklist / Output structure / Final action. Keep it focused; don't pad.

## Phase 4 — Validate with a dry run (the important part)

Call `create_skill` with **`dry_run: true`** and your draft. Read the result:
- **Trigger eval** — did the skill fire on its declared triggers? If it shows `✗ does NOT fire`, your glob/role/tag is wrong. If it shows `⚠ also fires: …`, you collide with another skill — tighten the trigger.
- **Warnings** — unknown tool names, slash-command clashes, empty description.
- **Discovery self-check** (you do this): given the neighboring descriptions from Phase 2, would *you* pick this skill for the user's example utterances and reject it for unrelated ones? If not, sharpen the `description`.

Iterate on the draft and re-run `dry_run` until the eval is clean and the description is discriminating.

## Phase 5 — Install

Call `create_skill` **without** `dry_run` to persist. Default `scope: "global"`; pass `scope: "project"` only if the user says it's specific to this project. Then give the user a 2-3 line summary: the id, how it activates (slash / trigger / discovery), and the scope. Do **not** paste the full body back.
