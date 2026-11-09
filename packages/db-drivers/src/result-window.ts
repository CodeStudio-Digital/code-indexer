/** Shared acquisition budget. Counters describe observed rows, never table size. */
export class ResultWindow {
  readonly rows: Array<Record<string, unknown>> = [];
  observed = 0;
  bytes = 0;
  cellsTruncated = 0;
  readonly max: number;
  constructor(max: number, readonly maxBytes = 4 * 1024 * 1024, readonly maxCellBytes = 64 * 1024) {
    this.max = Math.max(1, Math.min(10_000, Math.floor(max) || 1000));
  }
  push(row: Record<string, unknown>): void {
    this.observed++;
    if (this.rows.length >= this.max || this.bytes >= this.maxBytes) return;
    const bounded: Record<string, unknown> = {};
    let bytes = 0;
    for (const [key, value] of Object.entries(row)) {
      let cell = value;
      if (typeof value === 'string') {
        const encoded = Buffer.from(value);
        if (encoded.length > this.maxCellBytes) {
          let end = this.maxCellBytes;
          while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
          cell = encoded.subarray(0, end).toString('utf8'); this.cellsTruncated++;
        }
      } else if (Buffer.isBuffer(value) && value.length > this.maxCellBytes) {
        cell = Buffer.from(value.subarray(0, this.maxCellBytes)); this.cellsTruncated++;
      } else if (value && typeof value === 'object' && ('getData' in value || 'pipe' in value)) {
        cell = { omitted: true, reason: 'lob_requires_streaming_export' }; this.cellsTruncated++;
      } else if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        const encoded = JSON.stringify(value);
        if (encoded && Buffer.byteLength(encoded) > this.maxCellBytes) {
          cell = { omitted: true, reason: 'cell_byte_limit', bytes: Buffer.byteLength(encoded) }; this.cellsTruncated++;
        }
      }
      bytes += Buffer.byteLength(key) + (Buffer.isBuffer(cell) ? cell.length : Buffer.byteLength(typeof cell === 'string' ? cell : JSON.stringify(cell, (_key, v) => typeof v === 'bigint' ? String(v) : v) ?? 'null'));
      bounded[key] = cell;
    }
    if (this.bytes + bytes > this.maxBytes) { this.bytes = this.maxBytes; return; }
    this.bytes += bytes; this.rows.push(bounded);
  }
  get truncated(): boolean { return this.observed > this.rows.length || this.cellsTruncated > 0; }
  get acquisition() {
    return { mode: 'stream' as const, observedRows: this.observed, returnedRows: this.rows.length,
      retainedBytes: this.bytes, maxBytes: this.maxBytes, maxCellBytes: this.maxCellBytes,
      cellsTruncated: this.cellsTruncated, observedRowsExact: true };
  }
}
