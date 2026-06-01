/**
 * Per-provider icon + accent color mapping. Used by `ProviderTile`
 * (and any future surface that needs to visually distinguish a provider
 * at a glance). Lucide-only — we don't ship brand SVGs (license/size),
 * and the underlying icon is paired with a tinted bg so each kind reads
 * distinct at thumbnail size.
 *
 * Add a new mapping when a new `ProviderKind` is introduced. The
 * fallback (`Box`) keeps unknown kinds rendering without crashing.
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
import type { ProviderKind } from '../types.js';

interface ProviderVisual {
  icon: LucideIcon;
  /** Tailwind class for the icon foreground (`text-…`). */
  fg: string;
  /** Tailwind class for the tile background tint (`bg-…/15`). */
  bg: string;
}

const VISUALS: Record<ProviderKind, ProviderVisual> = {
  anthropic: { icon: Sparkles, fg: 'text-orange-500', bg: 'bg-orange-500/15' },
  'claude-code': { icon: Sparkles, fg: 'text-orange-400', bg: 'bg-orange-400/15' },
  openai: { icon: Brain, fg: 'text-emerald-500', bg: 'bg-emerald-500/15' },
  chatgpt: { icon: MessagesSquare, fg: 'text-emerald-400', bg: 'bg-emerald-400/15' },
  gemini: { icon: Zap, fg: 'text-sky-500', bg: 'bg-sky-500/15' },
  'google-oauth': { icon: Globe, fg: 'text-blue-500', bg: 'bg-blue-500/15' },
  bedrock: { icon: Cloud, fg: 'text-amber-500', bg: 'bg-amber-500/15' },
  // Copilot would be Github logo ideally; using Code2 because lucide
  // doesn't ship a stable Github export across versions (some builds
  // strip brand icons). Color stays Github-ish purple.
  copilot: { icon: Code2, fg: 'text-purple-500', bg: 'bg-purple-500/15' },
  openrouter: { icon: Network, fg: 'text-pink-500', bg: 'bg-pink-500/15' },
  'kimi-code': { icon: Bot, fg: 'text-cyan-500', bg: 'bg-cyan-500/15' },
  moonshot: { icon: Bot, fg: 'text-cyan-400', bg: 'bg-cyan-400/15' },
  cloudflare: { icon: Layers, fg: 'text-orange-600', bg: 'bg-orange-600/15' },
};

const FALLBACK: ProviderVisual = {
  icon: Box,
  fg: 'text-muted-foreground',
  bg: 'bg-muted',
};

export function providerVisual(kind: string): ProviderVisual {
  return VISUALS[kind as ProviderKind] ?? FALLBACK;
}

/** Convenience re-export so consumers don't need a second Lucide import. */
export { Cpu, KeyRound };
