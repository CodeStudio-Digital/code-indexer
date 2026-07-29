/**
 * One glyph per task kind, so the tree is scannable without reading labels.
 * Mirrors what Chrome's task manager does with its per-row icons.
 */
import {
  AppWindow, Boxes, Bug, Cpu, GitBranch, Hammer, Languages,
  type LucideIcon, MonitorPlay, Network, Package, Play, Server, SquareTerminal,
} from 'lucide-react';
import type { TaskKind } from './columns.js';

const ICONS: Record<TaskKind, LucideIcon> = {
  main: Cpu,
  renderer: AppWindow,
  gpu: MonitorPlay,
  utility: Package,
  worker: Boxes,
  terminal: SquareTerminal,
  runner: Play,
  devserver: Server,
  lsp: Languages,
  debug: Bug,
  mcp: Network,
  git: GitBranch,
  sandbox: Boxes,
  helper: Hammer,
  unknown: Package,
};

export function KindIcon({ kind, className }: { kind: TaskKind; className?: string }) {
  const Icon = ICONS[kind] ?? Package;
  return <Icon className={className} aria-hidden />;
}
