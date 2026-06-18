/**
 * Seletor de densidade da IDE no header (Compacto/Confortável/Grande).
 * Afeta UI base + Explorer + Monaco via state/ui-density.ts.
 */
import { ALargeSmall, Check } from 'lucide-react';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import { cn } from '../lib/utils.js';
import { useUiDensity, DENSITY_OPTIONS } from '../state/ui-density.js';

export function DensityToggle() {
  const density = useUiDensity((s) => s.density);
  const setDensity = useUiDensity((s) => s.setDensity);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Interface density" className="h-7 w-7">
              <ALargeSmall className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Interface density</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Density</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {DENSITY_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onSelect={() => setDensity(opt.value)}
            className="flex items-center justify-between"
          >
            <span>{opt.label}</span>
            <Check className={cn('h-3.5 w-3.5', density === opt.value ? 'opacity-100' : 'opacity-0')} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
