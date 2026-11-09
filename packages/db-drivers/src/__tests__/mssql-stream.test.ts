import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { boundedMssqlQuery } from '../mssql.js';

type StreamRequest = Parameters<typeof boundedMssqlQuery>[0];

/** Mirrors mssql 12.6.0 stream mode: SQL errors arrive only as 'error' events,
 * after which `query()` still resolves (lib/base/request.js). */
function streamingRequest(error?: Error): StreamRequest {
  const request = Object.assign(new EventEmitter(), {
    stream: false,
    input: () => request,
    cancel: () => undefined,
    query: (_sql: string) => new Promise<{ recordsets: unknown[]; rowsAffected: number[] }>((resolve) => {
      setImmediate(() => {
        request.emit('recordset', { id: {} });
        request.emit('row', { id: 1 });
        if (error) request.emit('error', error);
        request.emit('done', { rowsAffected: [1] });
        resolve({ recordsets: [], rowsAffected: [1] });
      });
    }),
  });
  return request as unknown as StreamRequest;
}

describe('boundedMssqlQuery in stream mode', () => {
  it('rejects with the error the driver reports as an event', async () => {
    const failure = new Error("Invalid object name 'missing_table'.");
    await expect(boundedMssqlQuery(streamingRequest(failure), 'SELECT * FROM missing_table', 10)).rejects.toBe(failure);
  });

  it('returns the streamed rows when the driver reports no error', async () => {
    const result = await boundedMssqlQuery(streamingRequest(), 'SELECT 1 AS id', 10);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.fields).toEqual([{ name: 'id' }]);
  });
});
