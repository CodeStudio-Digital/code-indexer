import type { PhpExtension } from '@mcp/api-bus';

/** Case-insensitive name filter used by the PHP extension settings list. */
export function filterPhpExtensions(extensions: PhpExtension[], query: string): PhpExtension[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return extensions;
  return extensions.filter((extension) => extension.name.toLocaleLowerCase().includes(normalized));
}
