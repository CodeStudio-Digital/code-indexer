const REPLACEMENT_CHAR_RE = /\uFFFD/u;

// Bytes 0x80-0x9f decoded as Windows-1252 become printable Unicode chars.
// Mapping them back lets us repair mojibake such as "â€™" -> "'".
const CP1252_REVERSE = new Map<string, number>([
  ['\u20AC', 0x80],
  ['\u201A', 0x82],
  ['\u0192', 0x83],
  ['\u201E', 0x84],
  ['\u2026', 0x85],
  ['\u2020', 0x86],
  ['\u2021', 0x87],
  ['\u02C6', 0x88],
  ['\u2030', 0x89],
  ['\u0160', 0x8a],
  ['\u2039', 0x8b],
  ['\u0152', 0x8c],
  ['\u017D', 0x8e],
  ['\u2018', 0x91],
  ['\u2019', 0x92],
  ['\u201C', 0x93],
  ['\u201D', 0x94],
  ['\u2022', 0x95],
  ['\u2013', 0x96],
  ['\u2014', 0x97],
  ['\u02DC', 0x98],
  ['\u2122', 0x99],
  ['\u0161', 0x9a],
  ['\u203A', 0x9b],
  ['\u0153', 0x9c],
  ['\u017E', 0x9e],
  ['\u0178', 0x9f],
]);

const CONTINUATION_MOJIBAKE_CHARS =
  '\\u0080-\\u00BF\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030\\u0160\\u2039\\u0152\\u017D' +
  '\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014\\u02DC\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178';

const UTF8_MOJIBAKE_SEQUENCE_RE = new RegExp(
  `[\\u00C2-\\u00DF][${CONTINUATION_MOJIBAKE_CHARS}]|` +
    `[\\u00E0-\\u00EF][${CONTINUATION_MOJIBAKE_CHARS}]{2}|` +
    `[\\u00F0-\\u00F4][${CONTINUATION_MOJIBAKE_CHARS}]{3}`,
  'gu',
);

const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function toOriginalByte(char: string): number | null {
  const code = char.codePointAt(0);
  if (code === undefined) return null;
  if (code <= 0xff) return code;
  return CP1252_REVERSE.get(char) ?? null;
}

function decodeMojibakeSequence(sequence: string): string | null {
  const chars = Array.from(sequence);
  const bytes = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i += 1) {
    const byte = toOriginalByte(chars[i] ?? '');
    if (byte === null) return null;
    bytes[i] = byte;
  }

  try {
    return FATAL_UTF8_DECODER.decode(bytes).normalize('NFC');
  } catch {
    return null;
  }
}

function countMojibakeSequences(text: string): number {
  let count = 0;
  UTF8_MOJIBAKE_SEQUENCE_RE.lastIndex = 0;
  while (UTF8_MOJIBAKE_SEQUENCE_RE.exec(text)) count += 1;
  UTF8_MOJIBAKE_SEQUENCE_RE.lastIndex = 0;
  return count;
}

function hasMojibakeSequence(text: string): boolean {
  UTF8_MOJIBAKE_SEQUENCE_RE.lastIndex = 0;
  const result = UTF8_MOJIBAKE_SEQUENCE_RE.test(text);
  UTF8_MOJIBAKE_SEQUENCE_RE.lastIndex = 0;
  return result;
}

function textQualityScore(text: string): number {
  let score = 0;
  if (REPLACEMENT_CHAR_RE.test(text)) score += 100;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && char !== '\n' && char !== '\r' && char !== '\t') score += 20;
  }

  score += countMojibakeSequences(text) * 10;
  return score;
}

export function repairMojibakeText(text: string): string {
  let current = text.normalize('NFC');

  for (let pass = 0; pass < 4; pass += 1) {
    const repaired = current.replace(UTF8_MOJIBAKE_SEQUENCE_RE, (sequence) => {
      const decoded = decodeMojibakeSequence(sequence);
      if (!decoded) return sequence;
      return textQualityScore(decoded) <= textQualityScore(sequence) ? decoded : sequence;
    });

    const normalized = repaired.normalize('NFC');
    if (normalized === current) break;
    current = normalized;
  }

  return current;
}

export function sanitizeSpecText<T>(value: T): T {
  if (typeof value === 'string') return repairMojibakeText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeSpecText(item)) as T;
  if (typeof value !== 'object' || value === null) return value;

  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = sanitizeSpecText(item);
  }
  return copy as T;
}

export function findSpecTextEncodingIssues(value: unknown, maxIssues = 20): string[] {
  const issues: string[] = [];

  function visit(item: unknown, path: string): void {
    if (issues.length >= maxIssues) return;

    if (typeof item === 'string') {
      if (REPLACEMENT_CHAR_RE.test(item)) {
        issues.push(`${path}: contains Unicode replacement characters (U+FFFD); rewrite this text with valid UTF-8 accents`);
      } else if (hasMojibakeSequence(item)) {
        issues.push(`${path}: appears to contain mojibake; rewrite this text with valid UTF-8 accents`);
      }
      return;
    }

    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }

    if (typeof item !== 'object' || item === null) return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      visit(child, path === '$' ? key : `${path}.${key}`);
    }
  }

  visit(value, '$');
  return issues;
}
