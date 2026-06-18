/**
 * Ícones de arquivo/pasta do Material Icon Theme (SVGs coloridos), com
 * fallback para os glifos lucide (lib/file-icon) quando o Material não cobre.
 * Renderiza via <img> (cacheado pelo browser, sem injeção de SVG).
 *
 * `className` controla o tamanho (ex. "h-3.5 w-3.5") — vale tanto para o <img>
 * quanto para o ícone lucide de fallback.
 */
import { Folder, FolderOpen } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { fileIconFor } from '../lib/file-icon.js';
import { materialIconForFile, materialIconForFolder } from '../lib/material-icons/resolve.js';

interface FileIconProps {
  /** Caminho completo (preferido — usado para nomes especiais) ou só o nome. */
  path?: string;
  name?: string;
  className?: string;
}

export function FileIcon({ path, name, className }: FileIconProps) {
  const key = path ?? name ?? '';
  const url = materialIconForFile(key);
  if (url) {
    return <img src={url} alt="" aria-hidden draggable={false} className={cn('shrink-0', className)} />;
  }
  const { Icon, colorClass } = fileIconFor(key);
  return <Icon className={cn('shrink-0', colorClass, className)} />;
}

interface FolderIconProps {
  name: string;
  expanded: boolean;
  className?: string;
}

export function FolderIcon({ name, expanded, className }: FolderIconProps) {
  const url = materialIconForFolder(name, expanded);
  if (url) {
    return <img src={url} alt="" aria-hidden draggable={false} className={cn('shrink-0', className)} />;
  }
  const Lucide = expanded ? FolderOpen : Folder;
  return <Lucide className={cn('shrink-0 text-amber-500/80', className)} />;
}
