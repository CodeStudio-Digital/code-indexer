import { describe, expect, it } from 'vitest';
import type { ApiRequest } from '../types.js';
import {
  folderMatchesCollectionSearch,
  normalizeCollectionSearch,
  requestMatchesCollectionSearch,
} from '../collection/collection-search.js';

const request = {
  name: 'Criar automação',
  method: 'POST',
  path_template: '/api/automations/:id',
  description: 'Cria uma rotina agendada',
} as ApiRequest;

describe('API collection search', () => {
  it('matches request metadata without accents or case sensitivity', () => {
    expect(requestMatchesCollectionSearch(request, normalizeCollectionSearch('AUTOMACAO'))).toBe(true);
    expect(requestMatchesCollectionSearch(request, normalizeCollectionSearch('post'))).toBe(true);
    expect(requestMatchesCollectionSearch(request, normalizeCollectionSearch('/automations'))).toBe(true);
    expect(requestMatchesCollectionSearch(request, normalizeCollectionSearch('agendada'))).toBe(true);
  });

  it('matches folder names and rejects unrelated requests', () => {
    expect(folderMatchesCollectionSearch('Autenticação', normalizeCollectionSearch('autenticacao'))).toBe(true);
    expect(requestMatchesCollectionSearch(request, normalizeCollectionSearch('webhook'))).toBe(false);
  });
});
