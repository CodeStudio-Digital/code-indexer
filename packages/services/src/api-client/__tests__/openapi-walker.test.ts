/**
 * Tests for the OpenAPI walker — operation enumeration, $ref resolution,
 * body-example synthesis, and success-status detection (OpenAPI 3.x).
 */
import { describe, it, expect } from 'vitest';
import { parseOpenApi } from '../openapi-walker.js';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'T', version: '1' },
  paths: {
    '/users/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'verbose', in: 'query', example: 'true' }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/users': {
      post: {
        operationId: 'createUser',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
});

describe('parseOpenApi', () => {
  it('enumerates operations with a stable hash', async () => {
    const a = await parseOpenApi(SPEC, 'json');
    const b = await parseOpenApi(SPEC, 'json');
    expect(a.hash).toBe(b.hash);
    expect(a.operations).toHaveLength(2);
  });

  it('captures query params + success status for GET', async () => {
    const { operations } = await parseOpenApi(SPEC, 'json');
    const get = operations.find((o) => o.method === 'GET' && o.path === '/users/{id}')!;
    expect(get.name).toBe('getUser');
    expect(get.query).toEqual({ verbose: 'true' });
    expect(get.successStatus).toBe(200);
  });

  it('synthesizes a body example from a $ref schema for POST', async () => {
    const { operations } = await parseOpenApi(SPEC, 'json');
    const post = operations.find((o) => o.method === 'POST')!;
    expect(post.successStatus).toBe(201);
    expect(post.bodyExample).toEqual({ id: 0, name: '', tags: [''] });
  });
});
