import type { DocumentBlock } from '@mcp/provider-sdk';

/** Render extracted text or a lazy local reference without embedding file bytes. */
export function renderTextDocument(block: Pick<DocumentBlock, 'name' | 'mediaType' | 'path' | 'text'>): string {
  const name = escapeXmlAttribute(block.name || 'attachment');
  const mediaType = escapeXmlAttribute(block.mediaType || 'application/octet-stream');
  if (block.path) {
    const path = escapeXmlAttribute(block.path);
    return `<file_reference name="${name}" mediaType="${mediaType}" path="${path}">\n` +
      'The file content is not embedded. Use read_file with this exact absolute path only when its contents are needed.\n' +
      '</file_reference>';
  }
  const text = (block.text ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>');
  return `<document name="${name}" mediaType="${mediaType}">\n<![CDATA[\n${text}\n]]>\n</document>`;
}

/** Provider-facing filename: basename only, no controls or markup punctuation. */
export function safeProviderFilename(name: string, fallback = 'document'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._()\[\] -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return clean || fallback;
}

/** Sanitize a native file input name and ensure its MIME-derived extension. */
export function safeDocumentFilename(block: Pick<DocumentBlock, 'name' | 'mediaType'>): string {
  const extension = DOCUMENT_EXTENSIONS[block.mediaType.toLowerCase()] ?? '';
  const fallback = extension ? `document.${extension}` : 'document';
  const clean = safeProviderFilename(block.name, fallback);
  return extension && !clean.toLowerCase().endsWith(`.${extension}`)
    ? `${clean}.${extension}`
    : clean;
}

export function unsupportedBinaryDocumentText(block: Pick<DocumentBlock, 'name' | 'mediaType'>): string {
  return `[attachment "${safeProviderFilename(block.name)}" could not be sent: provider does not support native ${block.mediaType} document input]`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const DOCUMENT_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
};
