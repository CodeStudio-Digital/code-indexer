/**
 * Map a file path to a Monaco language id + whether the workspace's
 * embedded LSP (TypeScript service) actually handles it.
 *
 * Anything beyond TS/JS is `lspSupported: false` today — syntax
 * highlighting still works via Monaco's built-in tokenizer, but
 * completion / hover / Ctrl+Click / diagnostics need a real LSP
 * (intelephense for PHP, jdtls for Java, omnisharp for C#, etc.)
 * we haven't shipped yet. The status bar surfaces this state so
 * users understand why their PHP file has highlight but no
 * IntelliSense.
 */

export interface LanguageInfo {
  language: string;
  label: string;
  lspSupported: boolean;
}

export function inferLanguage(filePath: string | null): LanguageInfo {
  if (!filePath) {
    return { language: 'plaintext', label: 'Plain text', lspSupported: false };
  }
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  // Cover the most common extensions explicitly; everything else falls
  // back to Monaco's built-in detection via filename.
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return { language: 'typescript', label: 'TypeScript', lspSupported: true };
    case 'tsx': return { language: 'typescript', label: 'TSX', lspSupported: true };
    case 'js': case 'mjs': case 'cjs': return { language: 'javascript', label: 'JavaScript', lspSupported: true };
    case 'jsx': return { language: 'javascript', label: 'JSX', lspSupported: true };
    case 'json': case 'jsonc': return { language: 'json', label: 'JSON', lspSupported: false };
    case 'md': case 'markdown': case 'mdx': return { language: 'markdown', label: 'Markdown', lspSupported: false };
    case 'css': return { language: 'css', label: 'CSS', lspSupported: false };
    case 'scss': return { language: 'scss', label: 'SCSS', lspSupported: false };
    case 'less': return { language: 'less', label: 'Less', lspSupported: false };
    case 'html': case 'htm': return { language: 'html', label: 'HTML', lspSupported: false };
    case 'xml': case 'svg': return { language: 'xml', label: 'XML', lspSupported: false };
    case 'yaml': case 'yml': return { language: 'yaml', label: 'YAML', lspSupported: false };
    case 'py': return { language: 'python', label: 'Python', lspSupported: false };
    case 'rb': return { language: 'ruby', label: 'Ruby', lspSupported: false };
    case 'go': return { language: 'go', label: 'Go', lspSupported: false };
    case 'rs': return { language: 'rust', label: 'Rust', lspSupported: false };
    case 'java': return { language: 'java', label: 'Java', lspSupported: false };
    case 'cs': return { language: 'csharp', label: 'C#', lspSupported: false };
    case 'php': return { language: 'php', label: 'PHP', lspSupported: false };
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return { language: 'cpp', label: 'C++', lspSupported: false };
    case 'c': case 'h': return { language: 'c', label: 'C', lspSupported: false };
    case 'kt': case 'kts': return { language: 'kotlin', label: 'Kotlin', lspSupported: false };
    case 'swift': return { language: 'swift', label: 'Swift', lspSupported: false };
    case 'dart': return { language: 'dart', label: 'Dart', lspSupported: false };
    case 'sql': return { language: 'sql', label: 'SQL', lspSupported: false };
    case 'sh': case 'bash': return { language: 'shell', label: 'Shell', lspSupported: false };
    case 'ps1': return { language: 'powershell', label: 'PowerShell', lspSupported: false };
    case 'dockerfile': return { language: 'dockerfile', label: 'Dockerfile', lspSupported: false };
    case 'toml': return { language: 'plaintext', label: 'TOML', lspSupported: false };
    case 'ini': return { language: 'plaintext', label: 'INI', lspSupported: false };
    case 'env': return { language: 'plaintext', label: 'Env', lspSupported: false };
    default: return { language: 'plaintext', label: ext.toUpperCase() || 'Plain text', lspSupported: false };
  }
}
