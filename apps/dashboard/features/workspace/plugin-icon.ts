/**
 * Maps a plugin tool window's declared `icon` name to a lucide component.
 * A small STATIC allowlist (not a dynamic import) keeps the bundle static
 * and stops manifests from referencing arbitrary module paths. Unknown or
 * missing names fall back to the generic Puzzle piece.
 */
import {
  Box,
  Cloud,
  Container,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  Package,
  Puzzle,
  Server,
  Terminal,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  box: Box,
  cloud: Cloud,
  container: Container,
  database: Database,
  globe: Globe,
  'hard-drive': HardDrive,
  'key-round': KeyRound,
  package: Package,
  server: Server,
  terminal: Terminal,
  zap: Zap,
};

export function pluginWindowIcon(name?: string): LucideIcon {
  return (name && ICONS[name]) || Puzzle;
}
