import { describe, expect, it } from 'vitest';
import { FileJson, Hash, Lock } from 'lucide-react';
import { fileIconFor } from '../file-icon.js';

describe('fileIconFor atypical files', () => {
  it.each(['.gitignore', '.dockerignore', '.algoignore', 'build/generated.ignore'])
  ('uses the ignore icon for %s', (path) => {
    expect(fileIconFor(path).Icon).toBe(Hash);
  });

  it.each(['data.jsonl', 'data.ndjson', 'settings.json5', 'payload.jsonb', 'policy.jsonnet'])
  ('uses the JSON icon for %s', (path) => {
    expect(fileIconFor(path).Icon).toBe(FileJson);
  });

  it('recognizes named and extension-based dotenv files', () => {
    expect(fileIconFor('.env.local').Icon).toBe(Lock);
    expect(fileIconFor('production.env').Icon).toBe(Lock);
  });
});
