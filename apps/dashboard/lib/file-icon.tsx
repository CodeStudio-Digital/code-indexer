/**
 * File icon + color per extension — single source of truth for the
 * file-type chrome shown in the file tree, tab bar, quick open,
 * markdown preview header, etc.
 *
 * The color cues come straight from VS Code's Seti / Material Icon
 * conventions (TS = blue, JS = yellow, MD = light blue, etc.) — users
 * recognise them at a glance, which is the whole point of file icons.
 *
 * Returns a React component pre-sized for an inline chip (12-14px),
 * already coloured. Callers control container size via the `className`
 * prop forwarded to the underlying lucide icon.
 */

import {
  Braces,
  Code2,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Hash,
  Image as ImageIcon,
  Lock,
  Settings,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface FileIconSpec {
  Icon: LucideIcon;
  /** Tailwind class — applied directly to the icon for inline coloring. */
  colorClass: string;
}

/**
 * Inferred from filename + extension. Order matters: special filenames
 * (Dockerfile, package.json, README.md) win over the bare extension.
 */
export function fileIconFor(path: string): FileIconSpec {
  const name = (path.split(/[/\\]/).pop() ?? path).toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';

  // ── Special filenames ─────────────────────────────────────
  if (name === 'package.json' || name === 'package-lock.json' || name === 'pnpm-lock.yaml' || name === 'yarn.lock')
    return { Icon: FileJson, colorClass: 'text-rose-400' };
  if (name === 'tsconfig.json' || name.startsWith('tsconfig.') && name.endsWith('.json'))
    return { Icon: Settings, colorClass: 'text-sky-400' };
  if (name === 'vite.config.ts' || name === 'vite.config.js')
    return { Icon: Wrench, colorClass: 'text-violet-400' };
  if (name.startsWith('dockerfile')) return { Icon: Wrench, colorClass: 'text-sky-300' };
  if (name === '.gitignore' || name === '.gitattributes' || name === '.gitmodules')
    return { Icon: Hash, colorClass: 'text-orange-400' };
  if (name === '.env' || name.startsWith('.env.')) return { Icon: Lock, colorClass: 'text-yellow-400' };
  if (name === 'readme.md' || name === 'readme') return { Icon: FileText, colorClass: 'text-blue-300' };
  if (name === 'license' || name === 'license.md' || name === 'license.txt')
    return { Icon: FileText, colorClass: 'text-zinc-300' };

  // ── Extensions ────────────────────────────────────────────
  switch (ext) {
    // TS / JS family
    case 'ts': case 'mts': case 'cts': return { Icon: FileCode2, colorClass: 'text-sky-400' };
    case 'tsx':                         return { Icon: FileCode2, colorClass: 'text-sky-300' };
    case 'js': case 'mjs': case 'cjs': return { Icon: FileCode2, colorClass: 'text-amber-300' };
    case 'jsx':                         return { Icon: FileCode2, colorClass: 'text-amber-200' };
    case 'json': case 'jsonc':          return { Icon: FileJson, colorClass: 'text-amber-300' };

    // Markup / docs
    case 'md': case 'markdown': case 'mdx': return { Icon: FileText, colorClass: 'text-blue-300' };
    case 'html': case 'htm':                return { Icon: Code2, colorClass: 'text-orange-400' };
    case 'xml': case 'svg':                 return { Icon: Code2, colorClass: 'text-orange-300' };
    case 'drawio':                          return { Icon: Workflow, colorClass: 'text-violet-300' };

    // Style
    case 'css':  return { Icon: Sparkles, colorClass: 'text-sky-300' };
    case 'scss': return { Icon: Sparkles, colorClass: 'text-pink-400' };
    case 'less': return { Icon: Sparkles, colorClass: 'text-indigo-300' };
    case 'sass': return { Icon: Sparkles, colorClass: 'text-pink-400' };

    // Data
    case 'yaml': case 'yml':  return { Icon: FileSpreadsheet, colorClass: 'text-rose-300' };
    case 'toml':              return { Icon: FileSpreadsheet, colorClass: 'text-rose-300' };
    case 'csv': case 'tsv':   return { Icon: FileSpreadsheet, colorClass: 'text-emerald-300' };
    case 'sql':               return { Icon: Braces, colorClass: 'text-cyan-300' };

    // Backend languages
    case 'py':                                              return { Icon: FileCode2, colorClass: 'text-green-300' };
    case 'rb':                                              return { Icon: FileCode2, colorClass: 'text-red-400' };
    case 'go':                                              return { Icon: FileCode2, colorClass: 'text-cyan-300' };
    case 'rs':                                              return { Icon: FileCode2, colorClass: 'text-orange-300' };
    case 'java':                                            return { Icon: FileCode2, colorClass: 'text-orange-400' };
    case 'kt': case 'kts':                                  return { Icon: FileCode2, colorClass: 'text-purple-400' };
    case 'swift':                                           return { Icon: FileCode2, colorClass: 'text-orange-400' };
    case 'cs':                                              return { Icon: FileCode2, colorClass: 'text-violet-400' };
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return { Icon: FileCode2, colorClass: 'text-blue-400' };
    case 'c': case 'h':                                     return { Icon: FileCode2, colorClass: 'text-blue-300' };
    case 'php':                                             return { Icon: FileCode2, colorClass: 'text-indigo-300' };
    case 'dart':                                            return { Icon: FileCode2, colorClass: 'text-cyan-400' };

    // Shell / scripting
    case 'sh': case 'bash': case 'zsh': case 'fish': return { Icon: Terminal, colorClass: 'text-emerald-300' };
    case 'ps1': case 'psm1':                          return { Icon: Terminal, colorClass: 'text-sky-300' };
    case 'bat': case 'cmd':                            return { Icon: Terminal, colorClass: 'text-zinc-300' };

    // Media
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'avif': case 'ico':
      return { Icon: ImageIcon, colorClass: 'text-fuchsia-300' };
    case 'mp3': case 'wav': case 'flac': case 'ogg': case 'm4a':
      return { Icon: FileAudio, colorClass: 'text-emerald-300' };
    case 'mp4': case 'webm': case 'mov': case 'avi': case 'mkv':
      return { Icon: FileVideo, colorClass: 'text-rose-300' };

    // Archives
    case 'zip': case 'tar': case 'gz': case 'bz2': case '7z': case 'rar':
      return { Icon: FileArchive, colorClass: 'text-amber-300' };

    // Generic image (covers extensions not in the explicit list)
    case 'bmp': case 'tiff': case 'tif':
      return { Icon: FileImage, colorClass: 'text-fuchsia-300' };

    default:
      return { Icon: FileText, colorClass: 'text-muted-foreground' };
  }
}
