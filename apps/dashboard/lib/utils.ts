import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Relative-time formatting now lives in the centralized datetime helper so
// every displayed date shares one timezone-correct parser. Re-exported here for
// the existing call sites that import it from `lib/utils`.
export { formatRelativeTime } from './datetime.js';
