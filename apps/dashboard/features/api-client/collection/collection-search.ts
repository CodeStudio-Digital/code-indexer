import type { ApiRequest } from '../types.js';

export function normalizeCollectionSearch(value: string): string {
  return value.trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function folderMatchesCollectionSearch(folder: string, normalizedQuery: string): boolean {
  return normalizeCollectionSearch(folder).includes(normalizedQuery);
}

export function requestMatchesCollectionSearch(request: ApiRequest, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [
    request.name,
    request.method,
    request.path_template,
    request.description,
  ].some((value) => value != null && normalizeCollectionSearch(String(value)).includes(normalizedQuery));
}
