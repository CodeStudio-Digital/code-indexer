/**
 * RFC-4180-ish CSV parsing for the table import. Pure + dependency-free so it's
 * testable: handles quoted fields, doubled-quote escapes, and commas/newlines
 * inside quotes. Rows map to insert value objects keyed by the header row.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  // Strip a UTF-8 BOM.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Map data rows to value objects keyed by header; empty cells → null. */
export function rowsToRecords(headers: string[], dataRows: string[][]): Array<Record<string, unknown>> {
  return dataRows.map((r) => {
    const rec: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const v = r[i];
      rec[h] = v === undefined || v === '' ? null : v;
    });
    return rec;
  });
}
