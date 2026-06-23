/**
 * Per-provider icon + accent color.
 *
 * The provider DEFINITION is the source of truth: the backend ships a
 * `visual` ({ icon: <lucide name>, fg, bg }) on each provider row and on
 * `/providers/known`. This module resolves that icon NAME to a Lucide
 * component (the definition stays Node-free / serializable) and keeps a
 * static per-kind fallback so older backends — and the brief window before
 * the providers fetch resolves — still render without a flash of the blank
 * `Box`. Unknown kinds fall back to `Box`.
 */
import {
  Bot,
  Box,
  Brain,
  Cloud,
  Code2,
  Cpu,
  Globe,
  KeyRound,
  Layers,
  MessagesSquare,
  Network,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ProviderVisualData } from '../types.js';

interface ResolvedVisual {
  icon: LucideIcon;
  /** Tailwind class for the icon foreground (`text-…`). */
  fg: string;
  /** Tailwind class for the tile background tint (`bg-…/15`). */
  bg: string;
}

/** Lucide icon NAME → component. The backend only ever ships the name. */
const ICON_BY_NAME: Record<string, LucideIcon> = {
  Bot,
  Box,
  Brain,
  Cloud,
  Code2,
  Cpu,
  Globe,
  KeyRound,
  Layers,
  MessagesSquare,
  Network,
  Sparkles,
  Zap,
};

/**
 * Static per-kind fallback, mirroring each definition's `visual`. Used when a
 * provider row carries no `visual` (older backend / a path that didn't enrich
 * it). Kept in sync with packages/services/src/providers/definitions/*.ts.
 */
const FALLBACK_BY_KIND: Record<string, ProviderVisualData> = {
  anthropic: { icon: 'Sparkles', fg: 'text-orange-500', bg: 'bg-orange-500/15' },
  'claude-code': { icon: 'Sparkles', fg: 'text-orange-400', bg: 'bg-orange-400/15' },
  openai: { icon: 'Brain', fg: 'text-emerald-500', bg: 'bg-emerald-500/15' },
  chatgpt: { icon: 'MessagesSquare', fg: 'text-emerald-400', bg: 'bg-emerald-400/15' },
  gemini: { icon: 'Zap', fg: 'text-sky-500', bg: 'bg-sky-500/15' },
  'google-oauth': { icon: 'Globe', fg: 'text-blue-500', bg: 'bg-blue-500/15' },
  bedrock: { icon: 'Cloud', fg: 'text-amber-500', bg: 'bg-amber-500/15' },
  copilot: { icon: 'Code2', fg: 'text-purple-500', bg: 'bg-purple-500/15' },
  openrouter: { icon: 'Network', fg: 'text-pink-500', bg: 'bg-pink-500/15' },
  'kimi-code': { icon: 'Bot', fg: 'text-cyan-500', bg: 'bg-cyan-500/15' },
  moonshot: { icon: 'Bot', fg: 'text-cyan-400', bg: 'bg-cyan-400/15' },
  cloudflare: { icon: 'Layers', fg: 'text-orange-600', bg: 'bg-orange-600/15' },
  deepseek: { icon: 'Cpu', fg: 'text-indigo-500', bg: 'bg-indigo-500/15' },
  zai: { icon: 'Sparkles', fg: 'text-violet-500', bg: 'bg-violet-500/15' },
};

const FALLBACK: ResolvedVisual = {
  icon: Box,
  fg: 'text-muted-foreground',
  bg: 'bg-muted',
};

/**
 * Resolve a provider's visual identity. Prefers the backend-provided `visual`
 * (the definition is the source of truth); falls back to the static per-kind
 * map, and finally to a generic `Box` so unknown kinds never crash.
 *
 * Accepts either a bare kind string (legacy call sites) or a provider-like
 * object carrying `{ kind, visual }`.
 */
export function providerVisual(
  input: string | { kind: string; visual?: ProviderVisualData | null },
): ResolvedVisual {
  const kind = typeof input === 'string' ? input : input.kind;
  const data =
    (typeof input === 'object' ? input.visual : null) ?? FALLBACK_BY_KIND[kind] ?? null;
  if (!data) return FALLBACK;
  return { icon: ICON_BY_NAME[data.icon] ?? Box, fg: data.fg, bg: data.bg };
}

/** Convenience re-export so consumers don't need a second Lucide import. */
export { Cpu, KeyRound };
